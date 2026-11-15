import React, { useEffect, useRef, useState } from 'react';
import { FolderTree, Image as ImageIcon, Upload, X } from 'lucide-react';
import type { BookMetadata } from '../types/bookshelf';

/* ---------- 上传图书弹窗 ---------- */
interface UploadBookModalProps {
  open: boolean;
  onClose: () => void;
  onConfirm: (data: {
    bookFile: File;
    title: string;
    coverFile: File | null;
  }) => Promise<void>;
}

export const UploadBookModal: React.FC<UploadBookModalProps> = ({
  open,
  onClose,
  onConfirm,
}) => {
  const [bookFile, setBookFile] = useState<File | null>(null);
  const [coverFile, setCoverFile] = useState<File | null>(null);
  const [coverPreview, setCoverPreview] = useState<string>('');
  const [title, setTitle] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const [saving, setSaving] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');

  const bookInputRef = useRef<HTMLInputElement>(null);
  const coverInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setBookFile(null);
      setCoverFile(null);
      setCoverPreview('');
      setTitle('');
      setErrorMsg('');
      setSaving(false);
    }
  }, [open]);

  if (!open) return null;

  const SUPPORTED_EXTS = [
    'epub',
    'pdf',
    'mobi',
    'azw3',
    'azw',
    'prc',
    'txt',
    'docx',
    'fb2',
    'md',
    'markdown',
    'html',
    'htm',
    'cbz',
  ];

  const handleBookPick = (file: File | undefined) => {
    if (!file) return;
    const ext = file.name.split('.').pop()?.toLowerCase() || '';
    if (!SUPPORTED_EXTS.includes(ext)) {
      setErrorMsg(
        '暂不支持该文件格式，目前支持：EPUB / PDF / MOBI / AZW3 / AZW / PRC / TXT / DOCX / FB2 / MD / HTML / CBZ'
      );
      return;
    }
    setErrorMsg('');
    setBookFile(file);
    if (!title.trim()) {
      setTitle(file.name.replace(/\.[^.]+$/, ''));
    }
  };

  const handleCoverPick = (file: File | undefined) => {
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setErrorMsg('请选择 PNG / JPG / WebP 格式的封面图片');
      return;
    }
    setErrorMsg('');
    setCoverFile(file);
    const reader = new FileReader();
    reader.onload = (e) => {
      setCoverPreview((e.target?.result as string) || '');
    };
    reader.readAsDataURL(file);
  };

  const handleSubmit = async () => {
    if (!bookFile) {
      setErrorMsg('请先选择电子书文件');
      return;
    }
    if (!title.trim()) {
      setErrorMsg('请填写书名');
      return;
    }
    setSaving(true);
    try {
      await onConfirm({ bookFile, title: title.trim(), coverFile });
      onClose();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : '保存失败，请重试');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/45 backdrop-blur-[2px] flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-[500px] bg-[#fffdf9] border border-[#e4ded3] rounded-2xl shadow-xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-[#e4ded3] flex items-center justify-between">
          <h2 className="text-[16px] font-bold text-[#26231f]">上传电子书到本地书架</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭弹窗"
            className="w-8 h-8 rounded-lg border border-[#e4ded3] bg-white text-[#6b655b] hover:text-[#26231f] flex items-center justify-center cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-4 max-h-[75vh] overflow-y-auto">
          <div>
            <label className="block text-[13px] font-medium text-[#6b655b] mb-1.5">
              1. 选择电子书文件（支持 PDF / EPUB / MOBI / AZW3 / TXT / DOCX / FB2 / MD / CBZ 等）
            </label>
            <div
              onClick={() => bookInputRef.current?.click()}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(false);
                handleBookPick(e.dataTransfer.files?.[0]);
              }}
              className={`border border-dashed rounded-xl p-5 text-center cursor-pointer transition-colors ${
                dragOver
                  ? 'border-[#3e5c47] bg-[#e7efe9] text-[#3e5c47]'
                  : 'border-[#ccc3b4] bg-[#f6f4ef] text-[#6b655b] hover:border-[#3e5c47]'
              }`}
            >
              <Upload className="w-5 h-5 mx-auto mb-1.5 opacity-80" />
              <div className="text-[13px]">
                {bookFile
                  ? `已选：${bookFile.name} (${(bookFile.size / 1024).toFixed(1)} KB)`
                  : '点击或拖拽电子书文件到此处'}
              </div>
              <div className="text-[11px] text-[#8a8377] mt-1">
                支持 .pdf / .epub / .mobi / .azw3 / .azw / .prc / .txt / .docx / .fb2 / .md / .html / .cbz
              </div>
              <input
                ref={bookInputRef}
                type="file"
                accept=".epub,.pdf,.mobi,.azw3,.azw,.prc,.txt,.docx,.fb2,.md,.markdown,.html,.htm,.cbz"
                className="hidden"
                onChange={(e) => handleBookPick(e.target.files?.[0])}
              />
            </div>
          </div>

          <div>
            <label className="block text-[13px] font-medium text-[#6b655b] mb-1.5">
              2. 书名
            </label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="选择文件后自动填充，可手动修改"
              className="w-full px-3 py-2 rounded-lg border border-[#e4ded3] bg-white text-[13px] text-[#26231f] outline-none focus:border-[#3e5c47]"
            />
          </div>

          <div>
            <label className="block text-[13px] font-medium text-[#6b655b] mb-1.5">
              3. 上传封面图片（可选，未上传时自动提取 EPUB 封面或生成极简封面）
            </label>
            <div className="flex items-center gap-4">
              <div className="w-[74px] h-[98px] rounded-lg border border-[#e4ded3] bg-[#ece7dc] overflow-hidden shrink-0 flex items-center justify-center text-[11px] text-[#8a8377]">
                {coverPreview ? (
                  <img src={coverPreview} alt="封面预览" className="w-full h-full object-cover" />
                ) : (
                  <ImageIcon className="w-5 h-5 opacity-60" />
                )}
              </div>
              <div className="flex-1">
                <input
                  ref={coverInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => handleCoverPick(e.target.files?.[0])}
                />
                <button
                  type="button"
                  onClick={() => coverInputRef.current?.click()}
                  className="px-3 py-1.5 rounded-lg border border-[#e4ded3] bg-white hover:bg-[#ece7dc] text-[12px] font-medium text-[#26231f] cursor-pointer"
                >
                  选择封面图片
                </button>
                <p className="text-[11px] text-[#8a8377] mt-2 leading-relaxed">
                  封面存入本地 <code className="text-[#3e5c47]">cover/</code> 目录，电子书原文件存入{' '}
                  <code className="text-[#3e5c47]">bookfile/</code>，元数据写入{' '}
                  <code className="text-[#3e5c47]">data/books.json</code>。
                </p>
              </div>
            </div>
          </div>

          {errorMsg && (
            <div className="text-[12px] text-[#b84a42] bg-[#fbeceb] border border-[#f0c9c6] rounded-lg px-3 py-2">
              {errorMsg}
            </div>
          )}
        </div>

        <div className="px-5 py-3.5 border-t border-[#e4ded3] bg-[#f6f4ef] flex justify-end gap-2.5">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-lg border border-[#e4ded3] bg-white text-[13px] font-medium text-[#26231f] hover:bg-[#ece7dc] cursor-pointer"
          >
            取消
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={handleSubmit}
            className="px-4 py-2 rounded-lg bg-[#3e5c47] hover:bg-[#2f4836] disabled:opacity-60 text-white text-[13px] font-medium cursor-pointer"
          >
            {saving ? '正在保存...' : '保存并加入书架'}
          </button>
        </div>
      </div>
    </div>
  );
};

/* ---------- 编辑图书弹窗 ---------- */
interface EditBookModalProps {
  book: BookMetadata | null;
  resolveCoverUrl: (book: BookMetadata) => Promise<string>;
  onClose: () => void;
  onConfirm: (bookId: string, newTitle: string, newCover: File | null) => Promise<void>;
}

export const EditBookModal: React.FC<EditBookModalProps> = ({
  book,
  resolveCoverUrl,
  onClose,
  onConfirm,
}) => {
  const [title, setTitle] = useState('');
  const [coverFile, setCoverFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState('');
  const [saving, setSaving] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (book) {
      setTitle(book.title);
      setCoverFile(null);
      setSaving(false);
      resolveCoverUrl(book).then((url) => setPreviewUrl(url));
    }
  }, [book, resolveCoverUrl]);

  if (!book) return null;

  const handleCoverPick = (file: File | undefined) => {
    if (!file || !file.type.startsWith('image/')) return;
    setCoverFile(file);
    const reader = new FileReader();
    reader.onload = (e) => setPreviewUrl((e.target?.result as string) || '');
    reader.readAsDataURL(file);
  };

  const handleSave = async () => {
    if (!title.trim()) return;
    setSaving(true);
    try {
      await onConfirm(book.id, title.trim(), coverFile);
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/45 backdrop-blur-[2px] flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-[440px] bg-[#fffdf9] border border-[#e4ded3] rounded-2xl shadow-xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-[#e4ded3] flex items-center justify-between">
          <h2 className="text-[16px] font-bold text-[#26231f]">修改图书信息</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭弹窗"
            className="w-8 h-8 rounded-lg border border-[#e4ded3] bg-white text-[#6b655b] hover:text-[#26231f] flex items-center justify-center cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          <div>
            <label className="block text-[13px] font-medium text-[#6b655b] mb-1.5">书名</label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-[#e4ded3] bg-white text-[13px] text-[#26231f] outline-none focus:border-[#3e5c47]"
            />
          </div>
          <div>
            <label className="block text-[13px] font-medium text-[#6b655b] mb-1.5">更换封面图片</label>
            <div className="flex items-center gap-4">
              <div className="w-[74px] h-[98px] rounded-lg border border-[#e4ded3] bg-[#ece7dc] overflow-hidden shrink-0 flex items-center justify-center text-[11px] text-[#8a8377]">
                {previewUrl ? (
                  <img src={previewUrl} alt="封面" className="w-full h-full object-cover" />
                ) : (
                  '无封面'
                )}
              </div>
              <div>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => handleCoverPick(e.target.files?.[0])}
                />
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="px-3 py-1.5 rounded-lg border border-[#e4ded3] bg-white hover:bg-[#ece7dc] text-[12px] font-medium text-[#26231f] cursor-pointer"
                >
                  选择新封面
                </button>
              </div>
            </div>
          </div>
        </div>

        <div className="px-5 py-3.5 border-t border-[#e4ded3] bg-[#f6f4ef] flex justify-end gap-2.5">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-lg border border-[#e4ded3] bg-white text-[13px] font-medium text-[#26231f] hover:bg-[#ece7dc] cursor-pointer"
          >
            取消
          </button>
          <button
            type="button"
            disabled={saving || !title.trim()}
            onClick={handleSave}
            className="px-4 py-2 rounded-lg bg-[#3e5c47] hover:bg-[#2f4836] disabled:opacity-60 text-white text-[13px] font-medium cursor-pointer"
          >
            {saving ? '保存中...' : '保存修改'}
          </button>
        </div>
      </div>
    </div>
  );
};

/* ---------- 本地文件夹存储说明弹窗 ---------- */
interface FolderGuideModalProps {
  open: boolean;
  folderName: string;
  isSupported: boolean;
  onClose: () => void;
  onBindFolder: () => void;
  onExportZip: () => void;
}

export const FolderGuideModal: React.FC<FolderGuideModalProps> = ({
  open,
  folderName,
  isSupported,
  onClose,
  onBindFolder,
  onExportZip,
}) => {
  if (!open) return null;

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
            <FolderTree className="w-4 h-4 text-[#3e5c47]" />
            <h2 className="text-[16px] font-bold text-[#26231f]">本地文件夹存放位置与数据结构说明</h2>
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

        <div className="p-5 space-y-4 text-[13px] text-[#26231f] leading-relaxed max-h-[75vh] overflow-y-auto">
          <p className="text-[#6b655b]">
            本应用为纯前端本地架构，所有书籍、封面、阅读进度与统计均保存在您的本地设备中，不自动上传任何云端服务器。
          </p>

          <div className="bg-[#f6f4ef] border border-[#e4ded3] rounded-xl p-4 font-mono text-[12px] text-[#26231f]">
            <div className="font-semibold text-[#3e5c47] mb-1.5">
              {folderName ? `当前已绑定文件夹：${folderName}/` : '您指定的本地根文件夹/（如 D:\\MyBookshelf）'}
            </div>
            <div>├── cover/ &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;# 存放所有图书封面图片</div>
            <div>├── bookfile/ &nbsp;&nbsp;&nbsp;# 存放上传的电子书原文件 (.epub / .txt)</div>
            <div>└── data/</div>
            <div>&nbsp;&nbsp;&nbsp;&nbsp;└── books.json &nbsp;# 存储书名、路径、开始阅读时间、进度与历史</div>
          </div>

          <div className="space-y-2 text-[12.5px] text-[#6b655b]">
            <p>
              <strong className="text-[#26231f]">1. 电脑硬盘直写模式：</strong>
              使用 Chrome / Edge 浏览器点击「绑定本地文件夹」并授权您电脑上的任意文件夹，即可自动创建上述 3 个子目录并实时写入。
            </p>
            <p>
              <strong className="text-[#26231f]">2. 浏览器离线缓存保障：</strong>
              即使暂未绑定文件夹（或在 iframe / Safari 等受限环境下），数据也会实时保存于浏览器 <code className="text-[#26231f]">localStorage</code> 与 <code className="text-[#26231f]">IndexedDB</code>，刷新页面不丢失，并可随时通过「导出本地书库」生成包含完整三目录结构的 ZIP 备份包。
            </p>
            <p>
              <strong className="text-[#26231f]">3. 豆包对话数据隔离：</strong>
              右侧豆包助手的对话记录与配置保存在独立的 <code className="text-[#26231f]">local_shelf_doubao_*</code> 键名中，绝不写入 <code className="text-[#26231f]">data/books.json</code>。
            </p>
          </div>
        </div>

        <div className="px-5 py-3.5 border-t border-[#e4ded3] bg-[#f6f4ef] flex justify-end gap-2.5">
          <button
            type="button"
            onClick={onExportZip}
            className="px-3.5 py-2 rounded-lg border border-[#e4ded3] bg-white text-[13px] font-medium text-[#26231f] hover:bg-[#ece7dc] cursor-pointer"
          >
            导出三目录 ZIP 包
          </button>
          {isSupported && (
            <button
              type="button"
              onClick={() => {
                onClose();
                onBindFolder();
              }}
              className="px-4 py-2 rounded-lg bg-[#3e5c47] hover:bg-[#2f4836] text-white text-[13px] font-medium cursor-pointer"
            >
              {folderName ? '更换本地文件夹' : '立即绑定本地文件夹'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

/* ---------- 通用确认弹窗（替代 window.confirm） ---------- */
interface ConfirmModalProps {
  open: boolean;
  title: string;
  description: string;
  confirmLabel?: string;
  danger?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

export const ConfirmModal: React.FC<ConfirmModalProps> = ({
  open,
  title,
  description,
  confirmLabel = '确认',
  danger = false,
  onCancel,
  onConfirm,
}) => {
  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/45 backdrop-blur-[2px] flex items-center justify-center p-4"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-[380px] bg-[#fffdf9] border border-[#e4ded3] rounded-2xl shadow-xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-[#e4ded3]">
          <h2 className="text-[15px] font-bold text-[#26231f]">{title}</h2>
        </div>
        <div className="px-5 py-4 text-[13px] text-[#6b655b] leading-relaxed">
          {description}
        </div>
        <div className="px-5 py-3 border-t border-[#e4ded3] bg-[#f6f4ef] flex justify-end gap-2.5">
          <button
            type="button"
            onClick={onCancel}
            className="px-3.5 py-1.5 rounded-lg border border-[#e4ded3] bg-white text-[13px] font-medium text-[#26231f] hover:bg-[#ece7dc] cursor-pointer"
          >
            取消
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className={`px-3.5 py-1.5 rounded-lg text-white text-[13px] font-medium cursor-pointer ${
              danger
                ? 'bg-[#b84a42] hover:bg-[#9c3b34]'
                : 'bg-[#3e5c47] hover:bg-[#2f4836]'
            }`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
};
