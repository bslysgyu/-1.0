import React, { useEffect, useState } from 'react';
import { CheckCircle2, Cloud, Eye, EyeOff, RefreshCw, Unplug, X } from 'lucide-react';
import type { WebDavConfig } from '../types/bookshelf';
import { testWebDavConnection } from '../services/webdavSync';

interface WebDavModalProps {
  open: boolean;
  config: WebDavConfig;
  syncing: boolean;
  onClose: () => void;
  onSaveAndSync: (cfg: WebDavConfig) => Promise<void>;
  onDisconnect: () => void;
}

export const WebDavModal: React.FC<WebDavModalProps> = ({
  open,
  config,
  syncing,
  onClose,
  onSaveAndSync,
  onDisconnect,
}) => {
  const [draft, setDraft] = useState<WebDavConfig>(config);
  const [showPwd, setShowPwd] = useState(false);
  const [testing, setTesting] = useState(false);
  const [statusMsg, setStatusMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    if (open) {
      setDraft(config);
      setStatusMsg(null);
      setShowPwd(false);
    }
  }, [open, config]);

  if (!open) return null;

  const handleTest = async () => {
    setTesting(true);
    setStatusMsg(null);
    const res = await testWebDavConnection(draft);
    setTesting(false);
    if (res.ok) {
      setStatusMsg({
        ok: true,
        text: '连接成功！已校验 WebDAV 权限并就绪 cover / bookfile / data 三个目录。',
      });
    } else {
      setStatusMsg({
        ok: false,
        text: res.error || '连接失败，请检查地址与账号密码',
      });
    }
  };

  const handleSave = async () => {
    setTesting(true);
    setStatusMsg(null);
    const nextCfg: WebDavConfig = {
      ...draft,
      url: draft.url.trim().replace(/\/+$/, ''),
      enabled: true,
    };
    const res = await testWebDavConnection(nextCfg);
    setTesting(false);
    if (!res.ok) {
      setStatusMsg({
        ok: false,
        text: res.error || '连接校验未通过',
      });
      return;
    }
    await onSaveAndSync(nextCfg);
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/45 backdrop-blur-[2px] flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-[520px] bg-[#fffdf9] border border-[#e4ded3] rounded-2xl shadow-xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-[#e4ded3] flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Cloud className="w-4 h-4 text-[#3e5c47]" />
            <h2 className="text-[16px] font-bold text-[#26231f]">
              WebDAV 跨设备网盘同步（iPad / 手机 / 电脑通用）
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭弹窗"
            className="w-8 h-8 rounded-lg border border-[#e4ded3] bg-white text-[#6b655b] hover:text-[#26231f] flex items-center justify-center cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-4 max-h-[75vh] overflow-y-auto text-[13px]">
          <p className="text-[#6b655b] leading-relaxed">
            在局域网 NAS（群晖 / 飞牛 fnOS / 威联通）、AList 或坚果云中填写同一个 WebDAV 目录，即可让{' '}
            <strong className="text-[#26231f]">iPad、手机、Windows 与 Mac</strong> 实时共用封面、电子书与阅读进度。
          </p>

          <div>
            <label className="block text-[12.5px] font-medium text-[#6b5d4f] mb-1">
              WebDAV 书库根目录地址
            </label>
            <input
              type="url"
              value={draft.url}
              onChange={(e) => setDraft({ ...draft, url: e.target.value })}
              placeholder="例如：http://192.168.1.10:5005/bookshelf 或 https://dav.jianguoyun.com/dav/MyBookshelf"
              className="w-full px-3 py-2 rounded-lg border border-[#e4ded3] bg-white text-[13px] text-[#26231f] outline-none focus:border-[#3e5c47]"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-[12.5px] font-medium text-[#6b5d4f] mb-1">
                账号 / 用户名
              </label>
              <input
                type="text"
                value={draft.username}
                onChange={(e) => setDraft({ ...draft, username: e.target.value })}
                placeholder="WebDAV 用户名"
                className="w-full px-3 py-2 rounded-lg border border-[#e4ded3] bg-white text-[13px] text-[#26231f] outline-none focus:border-[#3e5c47]"
              />
            </div>

            <div>
              <label className="block text-[12.5px] font-medium text-[#6b5d4f] mb-1">
                密码 / 应用专用密码
              </label>
              <div className="relative">
                <input
                  type={showPwd ? 'text' : 'password'}
                  value={draft.password}
                  onChange={(e) => setDraft({ ...draft, password: e.target.value })}
                  placeholder="仅保存于当前设备本地"
                  className="w-full pl-3 pr-9 py-2 rounded-lg border border-[#e4ded3] bg-white text-[13px] text-[#26231f] outline-none focus:border-[#3e5c47]"
                />
                <button
                  type="button"
                  onClick={() => setShowPwd((v) => !v)}
                  aria-label="切换密码显示"
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[#857564] hover:text-[#26231f] cursor-pointer"
                >
                  {showPwd ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>
          </div>

          <label className="flex items-center gap-2 text-[12.5px] text-[#26231f] cursor-pointer select-none">
            <input
              type="checkbox"
              checked={draft.autoSync}
              onChange={(e) => setDraft({ ...draft, autoSync: e.target.checked })}
              className="accent-[#3e5c47] w-4 h-4"
            />
            打开应用或翻页后自动与 WebDAV 同步进度与新增图书
          </label>

          {config.lastSyncAt && (
            <div className="text-[11.5px] text-[#6b655b] tabular-nums">
              上次同步时间：{config.lastSyncAt}
            </div>
          )}

          {statusMsg && (
            <div
              className={`rounded-xl px-3.5 py-2.5 text-[12.5px] leading-relaxed border ${
                statusMsg.ok
                  ? 'bg-[#e6efe8] text-[#2f4836] border-[#c4d6c8]'
                  : 'bg-[#fbeceb] text-[#9c3b34] border-[#f0c9c6]'
              }`}
            >
              {statusMsg.text}
            </div>
          )}

          <div className="bg-[#f6f4ef] border border-[#e4ded3] rounded-xl p-3.5 text-[12px] text-[#6b5d4f] space-y-1.5 leading-relaxed">
            <div className="font-semibold text-[#26231f]">iPad / 手机连接局域网小贴士：</div>
            <div>
              1. 如果你的电脑或 NAS 用 <strong className="text-[#26231f]">http://192.168.x.x</strong> 提供局域网 WebDAV，请确保静态网页也部署在局域网 HTTP 地址（或给 WebDAV 开启 HTTPS + CORS 跨域允许）。
            </div>
            <div>
              2. 无 NAS 也可在电脑一键启动轻量服务：运行 <code className="text-[#26231f]">dufs -A --allow-all 书库目录</code> 或用 AList 开启 WebDAV。
            </div>
            <div>
              3. 账号密码仅保存在当前设备 <code className="text-[#26231f]">localStorage</code> 中，不会写入 <code className="text-[#26231f]">data/books.json</code>。
            </div>
          </div>
        </div>

        <div className="px-5 py-3.5 border-t border-[#e4ded3] bg-[#f6f4ef] flex flex-wrap items-center justify-between gap-2">
          <div>
            {config.enabled && (
              <button
                type="button"
                onClick={() => {
                  onDisconnect();
                  onClose();
                }}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-[#e6c4c2] bg-white hover:bg-[#fbeceb] text-[#b84a42] text-[12.5px] font-medium cursor-pointer"
              >
                <Unplug className="w-3.5 h-3.5" />
                断开同步
              </button>
            )}
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={testing || syncing}
              onClick={handleTest}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg border border-[#e4ded3] bg-white hover:bg-[#ece7dc] disabled:opacity-60 text-[13px] font-medium text-[#26231f] cursor-pointer"
            >
              <CheckCircle2 className="w-3.5 h-3.5" />
              {testing ? '检测中...' : '测试连接'}
            </button>

            <button
              type="button"
              disabled={testing || syncing || !draft.url.trim()}
              onClick={handleSave}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#3e5c47] hover:bg-[#2f4836] disabled:opacity-60 text-white text-[13px] font-medium cursor-pointer"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${syncing ? 'animate-spin' : ''}`} />
              {syncing ? '正在同步...' : '保存并立即同步'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
