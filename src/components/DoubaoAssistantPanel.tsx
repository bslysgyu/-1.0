import React, { useEffect, useRef, useState } from 'react';
import {
  BookMarked,
  Copy,
  PanelRightClose,
  Send,
  Settings2,
  Sparkles,
  Square,
  Trash2,
  X,
} from 'lucide-react';
import type {
  ChatMessage,
  DoubaoConfig,
  QuickActionType,
} from '../types/bookshelf';
import {
  loadChatHistory,
  loadDoubaoConfig,
  saveChatHistory,
  saveDoubaoConfig,
} from '../services/localStorageDb';
import { genId } from '../utils/dateStats';

interface DoubaoAssistantPanelProps {
  collapsed: boolean;
  onToggleCollapse: () => void;
  currentBookTitle: string | null;
  currentPageText: string;
  externalTrigger: {
    id: number;
    quote: string;
    action: QuickActionType | 'quote';
  } | null;
  onNotify: (msg: string) => void;
  onRequestClearConfirm: (onConfirm: () => void) => void;
}

const ACTION_CONFIG: Record<
  QuickActionType,
  { label: string; promptPrefix: string }
> = {
  explain: {
    label: '提问释义',
    promptPrefix: '请结合上下文，为我详细解释以下文字的含义、背景或核心概念：',
  },
  summarize: {
    label: '总结段落',
    promptPrefix: '请精炼总结以下段落的核心意思与关键脉络：',
  },
  notes: {
    label: '提炼读书笔记',
    promptPrefix: '请从以下内容中提炼结构化的读书笔记（含核心观点、金句摘录与关键词）：',
  },
  analyze: {
    label: '分析内容',
    promptPrefix: '请从写作手法、逻辑结构、人物心理或深层主旨角度深度分析以下内容：',
  },
  review: {
    label: '生成读后感',
    promptPrefix: '请基于以下书籍片段，为我撰写一段有思考深度的读后感：',
  },
};

function renderMarkdownParagraphs(text: string): React.ReactNode {
  const lines = text.split(/\r?\n/);
  return lines.map((line, i) => {
    const trimmed = line.trim();
    if (!trimmed) return <div key={i} className="h-2" />;
    const boldFormatted = trimmed.split(/(\*\*[^*]+\*\*)/g).map((part, idx) => {
      if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
        return (
          <strong key={idx} className="font-semibold">
            {part.slice(2, -2)}
          </strong>
        );
      }
      return part;
    });
    if (trimmed.startsWith('### ') || trimmed.startsWith('## ') || trimmed.startsWith('# ')) {
      return (
        <p key={i} className="font-semibold text-[13.5px] mt-1.5 mb-1">
          {trimmed.replace(/^#{1,3}\s+/, '')}
        </p>
      );
    }
    if (/^[-*]\s+/.test(trimmed)) {
      return (
        <div key={i} className="pl-3 flex gap-1.5 my-0.5">
          <span className="opacity-60">•</span>
          <span>{boldFormatted}</span>
        </div>
      );
    }
    return (
      <p key={i} className="my-1 leading-relaxed">
        {boldFormatted}
      </p>
    );
  });
}

export const DoubaoAssistantPanel: React.FC<DoubaoAssistantPanelProps> = ({
  collapsed,
  onToggleCollapse,
  currentBookTitle,
  currentPageText,
  externalTrigger,
  onNotify,
  onRequestClearConfirm,
}) => {
  const [config, setConfig] = useState<DoubaoConfig>(() => loadDoubaoConfig());
  const [configOpen, setConfigOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>(() => loadChatHistory());
  const [quoteText, setQuoteText] = useState('');
  const [inputText, setInputText] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const lastTriggerIdRef = useRef<number>(0);

  useEffect(() => {
    saveChatHistory(messages);
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const sendMessageToDoubao = async (promptText: string, explicitQuote?: string) => {
    const activeQuote = (explicitQuote !== undefined ? explicitQuote : quoteText).trim();
    const trimmedPrompt = promptText.trim();
    if (!trimmedPrompt && !activeQuote) {
      onNotify('请输入问题或先在书中划选文字');
      return;
    }

    if (!config.apiKey.trim()) {
      setConfigOpen(true);
      onNotify('请先点击右上角设置填写豆包 API Key（仅存本地浏览器）');
      return;
    }
    if (!config.model.trim()) {
      setConfigOpen(true);
      onNotify('请填写豆包模型名称或推理接入点 ID');
      return;
    }

    const nowTime = new Date().toLocaleTimeString('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
    });

    const userMsg: ChatMessage = {
      id: genId('msg'),
      role: 'user',
      content: trimmedPrompt || '请帮我解读这段内容：',
      quote: activeQuote || undefined,
      bookTitle: currentBookTitle || undefined,
      time: nowTime,
    };

    const assistantMsgId = genId('msg');
    const placeholderAssistant: ChatMessage = {
      id: assistantMsgId,
      role: 'assistant',
      content: '正在连接豆包思考...',
      time: nowTime,
    };

    setMessages((prev) => [...prev, userMsg, placeholderAssistant]);
    setQuoteText('');
    setIsStreaming(true);

    const controller = new AbortController();
    abortRef.current = controller;

    const historySlice = messages.slice(-8).map((m) => ({
      role: m.role,
      content: m.quote ? `${m.content}\n\n【摘录原文】\n${m.quote}` : m.content,
    }));

    const fullUserPrompt = `${
      currentBookTitle ? `（当前正在阅读：《${currentBookTitle}》）\n` : ''
    }${userMsg.content}${activeQuote ? `\n\n【摘录原文】\n“${activeQuote}”` : ''}`;

    const apiMessages = [
      {
        role: 'system',
        content:
          '你是私人阅读伴读助手“豆包”。请结合用户提供的书籍上下文与问题，用条理清晰、温润克制的中文回答，重点突出阅读洞见。',
      },
      ...historySlice,
      { role: 'user', content: fullUserPrompt },
    ];

    const updateAssistantText = (nextContent: string) => {
      setMessages((prev) =>
        prev.map((m) => (m.id === assistantMsgId ? { ...m, content: nextContent } : m))
      );
    };

    try {
      const resp = await fetch(config.endpoint.trim(), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.apiKey.trim()}`,
        },
        body: JSON.stringify({
          model: config.model.trim(),
          messages: apiMessages,
          stream: config.stream,
        }),
        signal: controller.signal,
      });

      if (!resp.ok) {
        const errBody = await resp.text();
        throw new Error(`HTTP ${resp.status}: ${errBody.slice(0, 220)}`);
      }

      const contentType = resp.headers.get('content-type') || '';
      if (config.stream && contentType.includes('text/event-stream') && resp.body) {
        const reader = resp.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let accumulated = '';
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const rawLine of lines) {
            const line = rawLine.trim();
            if (!line.startsWith('data:')) continue;
            const dataStr = line.slice(5).trim();
            if (dataStr === '[DONE]') continue;
            try {
              const json = JSON.parse(dataStr);
              const delta = json.choices?.[0]?.delta?.content || '';
              if (delta) {
                accumulated += delta;
                updateAssistantText(accumulated);
              }
            } catch {
              // ignore partial stream chunk
            }
          }
        }
        if (!accumulated) {
          updateAssistantText('（豆包未返回有效文本内容）');
        }
      } else {
        const data = await resp.json();
        const text = data.choices?.[0]?.message?.content || JSON.stringify(data);
        updateAssistantText(text);
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantMsgId
              ? {
                  ...m,
                  content:
                    (m.content === '正在连接豆包思考...' ? '' : m.content) +
                    '\n\n（已手动停止生成）',
                }
              : m
          )
        );
      } else {
        const msg = err instanceof Error ? err.message : '未知网络错误';
        updateAssistantText(
          `调用豆包大模型接口失败：${msg}\n\n请检查：\n1. API Key 与模型 / 接入点 ID（如 ep-xxxx）是否正确\n2. 浏览器网络环境是否允许直连 ${config.endpoint}`
        );
      }
    } finally {
      setIsStreaming(false);
      abortRef.current = null;
    }
  };

  // Handle selection actions coming from BookReader
  useEffect(() => {
    if (!externalTrigger || externalTrigger.id === lastTriggerIdRef.current) return;
    lastTriggerIdRef.current = externalTrigger.id;
    const { quote, action } = externalTrigger;

    if (action === 'quote') {
      setQuoteText(quote);
      setTimeout(() => inputRef.current?.focus(), 80);
    } else {
      const cfg = ACTION_CONFIG[action];
      if (cfg) {
        sendMessageToDoubao(`${cfg.label}\n${cfg.promptPrefix}`, quote);
      }
    }
  }, [externalTrigger]);

  const handleQuickAction = (action: QuickActionType) => {
    const cfg = ACTION_CONFIG[action];
    let targetQuote = quoteText;
    if (!targetQuote && currentPageText) {
      targetQuote = currentPageText.slice(0, 900);
      onNotify('未检测到选中文本，已自动附带当前阅读页片段');
    }
    sendMessageToDoubao(`${cfg.label}\n${cfg.promptPrefix}`, targetQuote);
  };

  const handleSaveConfig = () => {
    saveDoubaoConfig(config);
    setConfigOpen(false);
    onNotify('豆包接口配置已保存至本地浏览器');
  };

  return (
    <aside
      aria-label="豆包阅读助手"
      className={`shrink-0 bg-[#fffdf9] border-l border-[#e4ded3] flex flex-col h-full transition-all duration-200 overflow-hidden ${
        collapsed ? 'w-0 border-l-0 opacity-0 pointer-events-none' : 'w-[380px]'
      }`}
    >
      {/* Panel Header */}
      <div className="px-4 py-3.5 border-b border-[#e4ded3] flex items-center justify-between gap-2 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-7 h-7 rounded-lg bg-[#e7efe9] text-[#3e5c47] flex items-center justify-center shrink-0">
            <Sparkles className="w-4 h-4" />
          </div>
          <div className="min-w-0">
            <h2 className="text-[14px] font-bold text-[#26231f] truncate">豆包阅读助手</h2>
          </div>
        </div>

        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            title="配置豆包大模型接口"
            onClick={() => setConfigOpen((v) => !v)}
            className={`w-8 h-8 rounded-lg border flex items-center justify-center cursor-pointer transition-colors ${
              configOpen
                ? 'border-[#3e5c47] bg-[#e7efe9] text-[#3e5c47]'
                : 'border-[#e4ded3] bg-white text-[#6b655b] hover:text-[#26231f]'
            }`}
          >
            <Settings2 className="w-4 h-4" />
          </button>
          <button
            type="button"
            title="清空本地对话记录"
            onClick={() => {
              if (messages.length === 0) return;
              onRequestClearConfirm(() => {
                setMessages([]);
                saveChatHistory([]);
                onNotify('已清空豆包对话记录');
              });
            }}
            className="w-8 h-8 rounded-lg border border-[#e4ded3] bg-white text-[#6b655b] hover:text-[#b84a42] flex items-center justify-center cursor-pointer transition-colors"
          >
            <Trash2 className="w-4 h-4" />
          </button>
          <button
            type="button"
            title="收起豆包助手面板"
            onClick={onToggleCollapse}
            className="w-8 h-8 rounded-lg border border-[#e4ded3] bg-white text-[#6b655b] hover:text-[#26231f] flex items-center justify-center cursor-pointer transition-colors"
          >
            <PanelRightClose className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Collapsible Doubao API Configuration Drawer */}
      {configOpen && (
        <div className="px-4 py-3.5 bg-[#f6f4ef] border-b border-[#e4ded3] space-y-2.5 text-[12px] shrink-0">
          <div>
            <label className="block text-[#6b655b] mb-1">豆包 API 接口地址</label>
            <input
              type="text"
              value={config.endpoint}
              onChange={(e) => setConfig({ ...config, endpoint: e.target.value })}
              className="w-full px-2.5 py-1.5 rounded-lg border border-[#e4ded3] bg-white text-[#26231f] outline-none focus:border-[#3e5c47]"
            />
          </div>
          <div>
            <label className="block text-[#6b655b] mb-1">火山方舟 API Key（仅存本地）</label>
            <input
              type="password"
              value={config.apiKey}
              onChange={(e) => setConfig({ ...config, apiKey: e.target.value })}
              placeholder="输入 Bearer API Key"
              className="w-full px-2.5 py-1.5 rounded-lg border border-[#e4ded3] bg-white text-[#26231f] outline-none focus:border-[#3e5c47]"
            />
          </div>
          <div>
            <label className="block text-[#6b655b] mb-1">模型名 / 接入点 ID</label>
            <input
              type="text"
              value={config.model}
              onChange={(e) => setConfig({ ...config, model: e.target.value })}
              placeholder="例如 doubao-1-5-pro-32k-250115 或 ep-xxxx"
              className="w-full px-2.5 py-1.5 rounded-lg border border-[#e4ded3] bg-white text-[#26231f] outline-none focus:border-[#3e5c47]"
            />
          </div>
          <div className="flex items-center justify-between pt-1">
            <label className="flex items-center gap-1.5 text-[#6b655b] cursor-pointer">
              <input
                type="checkbox"
                checked={config.stream}
                onChange={(e) => setConfig({ ...config, stream: e.target.checked })}
                className="accent-[#3e5c47]"
              />
              开启流式输出
            </label>
            <button
              type="button"
              onClick={handleSaveConfig}
              className="px-3 py-1 rounded-lg bg-[#3e5c47] hover:bg-[#2f4836] text-white font-medium cursor-pointer"
            >
              保存配置
            </button>
          </div>
        </div>
      )}

      {/* Selected Book Text Context */}
      {quoteText && (
        <div className="px-4 py-2.5 bg-[#f4ece0] border-b border-[#e5d6c1] shrink-0">
          <div className="flex items-center justify-between text-[11px] font-semibold text-[#7c5d38] mb-1">
            <span className="flex items-center gap-1">
              <BookMarked className="w-3.5 h-3.5" />
              已选中书中原文
            </span>
            <button
              type="button"
              onClick={() => setQuoteText('')}
              className="text-[#7c5d38] hover:text-[#26231f] flex items-center gap-0.5 cursor-pointer"
            >
              <X className="w-3 h-3" />
              清除
            </button>
          </div>
          <p className="text-[12px] text-[#26231f] leading-relaxed line-clamp-3">
            {quoteText}
          </p>
        </div>
      )}

      {/* 5 Quick Reading Assistance Buttons */}
      <div className="px-3.5 py-2.5 border-b border-[#e4ded3] flex flex-wrap gap-1.5 shrink-0 bg-[#fffdf9]">
        {(Object.keys(ACTION_CONFIG) as QuickActionType[]).map((key) => (
          <button
            key={key}
            type="button"
            disabled={isStreaming}
            onClick={() => handleQuickAction(key)}
            className="px-2.5 py-1 rounded-lg border border-[#e4ded3] bg-[#f6f4ef] hover:bg-[#e7efe9] hover:border-[#bfd3c4] hover:text-[#3e5c47] text-[12px] text-[#26231f] transition-colors cursor-pointer disabled:opacity-50 whitespace-nowrap"
          >
            {ACTION_CONFIG[key].label}
          </button>
        ))}
      </div>

      {/* Chat Messages Area (Isolated from Book Metadata) */}
      <div className="flex-1 overflow-y-auto px-3.5 py-4 space-y-3 bg-[#faf8f3]">
        {messages.length === 0 ? (
          <div className="text-center text-[#6b655b] text-[12.5px] leading-relaxed py-8 px-3">
            <p className="font-semibold text-[#26231f] mb-2">豆包伴读空间</p>
            <p className="mb-2">
              1. 点击上方设置图标配置豆包大模型接口与接入点。
            </p>
            <p className="mb-2">
              2. 在左侧阅读书中文字时<strong className="text-[#26231f]">划选任意段落</strong>，即可一键释义、总结、提炼读书笔记、深度分析或生成读后感。
            </p>
            <p className="text-[#8a8377] text-[11.5px] mt-3">
              对话记录仅保存于浏览器独立本地存储，不污染您的书架文件夹与阅读统计数据。
            </p>
          </div>
        ) : (
          messages.map((msg) => (
            <div
              key={msg.id}
              className={`flex flex-col gap-1 max-w-[94%] ${
                msg.role === 'user' ? 'ml-auto items-end' : 'mr-auto items-start'
              }`}
            >
              <div
                className={`px-3.5 py-2.5 rounded-xl text-[13px] break-words ${
                  msg.role === 'user'
                    ? 'bg-[#3e5c47] text-white rounded-br-sm'
                    : 'bg-white text-[#26231f] border border-[#e4ded3] rounded-bl-sm'
                }`}
              >
                {msg.quote && (
                  <div className="mb-2 pb-2 border-b border-white/20 text-[12px] opacity-90 italic">
                    “{msg.quote.length > 160 ? `${msg.quote.slice(0, 160)}...` : msg.quote}”
                  </div>
                )}
                {msg.role === 'assistant' ? (
                  <div>{renderMarkdownParagraphs(msg.content)}</div>
                ) : (
                  <div className="whitespace-pre-wrap leading-relaxed">{msg.content}</div>
                )}
              </div>

              <div className="flex items-center gap-2 text-[11px] text-[#8a8377] px-1 tabular-nums">
                <span>{msg.time}</span>
                {msg.role === 'assistant' && msg.content && (
                  <button
                    type="button"
                    onClick={() => {
                      navigator.clipboard?.writeText(msg.content);
                      onNotify('已复制豆包回复');
                    }}
                    className="inline-flex items-center gap-0.5 hover:text-[#26231f] cursor-pointer"
                  >
                    <Copy className="w-3 h-3" />
                    复制
                  </button>
                )}
              </div>
            </div>
          ))
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input Footer */}
      <div className="p-3.5 border-t border-[#e4ded3] bg-[#fffdf9] shrink-0">
        <textarea
          ref={inputRef}
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              if (!isStreaming) {
                const txt = inputText;
                setInputText('');
                sendMessageToDoubao(txt);
              }
            }
          }}
          placeholder="输入问题，或划选左侧书中文字发送给豆包... (Enter 发送)"
          className="w-full min-h-[62px] max-h-[130px] resize-y px-3 py-2 rounded-lg border border-[#e4ded3] bg-white text-[13px] text-[#26231f] outline-none focus:border-[#3e5c47] leading-relaxed"
        />
        <div className="flex items-center justify-between mt-2 gap-2">
          <span className="text-[11px] text-[#8a8377] truncate">
            对话本地独立保存 · 不写入书籍 JSON
          </span>
          <div className="flex items-center gap-1.5 shrink-0">
            {isStreaming && (
              <button
                type="button"
                onClick={() => abortRef.current?.abort()}
                className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-[#fbeceb] text-[#b84a42] border border-[#f0c9c6] text-[12px] font-medium cursor-pointer"
              >
                <Square className="w-3 h-3" />
                停止
              </button>
            )}
            <button
              type="button"
              disabled={isStreaming}
              onClick={() => {
                const txt = inputText;
                setInputText('');
                sendMessageToDoubao(txt);
              }}
              className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-[#3e5c47] hover:bg-[#2f4836] disabled:opacity-50 text-white text-[12px] font-medium cursor-pointer"
            >
              <Send className="w-3.5 h-3.5" />
              发送
            </button>
          </div>
        </div>
      </div>
    </aside>
  );
};
