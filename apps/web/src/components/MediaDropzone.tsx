'use client';

import React, { useRef, useState } from 'react';
import { uploadMedia } from '@/lib/api';
import { useToast } from '@/components/Toast';

export interface MediaValue {
  url: string;
  type?: 'IMAGE' | 'VIDEO' | 'DOCUMENT';
  filename?: string;
  mimeType?: string;
}

interface MediaDropzoneProps {
  value: MediaValue | null;
  onChange: (media: MediaValue | null) => void;
  /** false for carousel cards — CarouselCardDef.mediaType is IMAGE|VIDEO only. */
  allowDocument?: boolean;
  label?: string;
  /** Tighter footprint for use inside a carousel card. */
  compact?: boolean;
}

const IMAGE_VIDEO_ACCEPT = 'image/jpeg,image/png,image/webp,image/gif,video/mp4,video/3gpp';
const ALL_ACCEPT = `${IMAGE_VIDEO_ACCEPT},application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`;

const labelStyle: React.CSSProperties = { display: 'block', fontSize: 11, fontWeight: 500, color: 'var(--text-muted)', marginBottom: 6, letterSpacing: '0.8px', textTransform: 'uppercase' };

const IcUpload = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" />
  </svg>
);
const IcFile = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" />
  </svg>
);
const IcX = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
    <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
  </svg>
);

const EXT_TO_TYPE: Record<string, 'IMAGE' | 'VIDEO' | 'DOCUMENT'> = {
  jpg: 'IMAGE', jpeg: 'IMAGE', png: 'IMAGE', webp: 'IMAGE', gif: 'IMAGE',
  mp4: 'VIDEO', '3gp': 'VIDEO',
  pdf: 'DOCUMENT', doc: 'DOCUMENT', docx: 'DOCUMENT', xls: 'DOCUMENT', xlsx: 'DOCUMENT',
};

/** Template.mediaUrl only stores a URL string, not a type — older saved templates (or
 * anything loaded without a fresh upload response) need their type inferred from the
 * file extension so the preview picks the right renderer. */
function inferType(url: string): 'IMAGE' | 'VIDEO' | 'DOCUMENT' {
  const ext = url.split('.').pop()?.toLowerCase().split(/[?#]/)[0] ?? '';
  return EXT_TO_TYPE[ext] ?? 'IMAGE';
}

function formatSize(bytes?: number): string {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Real drag-and-drop media upload with per-type preview (image/video/document). */
export function MediaDropzone({ value, onChange, allowDocument = false, label = 'Media (optional)', compact = false }: MediaDropzoneProps) {
  const { toast } = useToast();
  const [dragActive, setDragActive] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [size, setSize] = useState<number | undefined>(undefined);
  const inputRef = useRef<HTMLInputElement>(null);
  const accept = allowDocument ? ALL_ACCEPT : IMAGE_VIDEO_ACCEPT;
  const boxHeight = compact ? 110 : 220;

  const handleFile = async (file: File) => {
    setUploading(true);
    try {
      const saved = await uploadMedia(file);
      setSize(saved.size);
      onChange({ url: saved.url, type: saved.type, filename: saved.filename, mimeType: saved.mimeType });
      toast(`Attached: ${saved.filename}`, 'success');
    } catch (err) {
      toast(`Upload failed: ${String(err)}`, 'error');
    } finally {
      setUploading(false);
    }
  };

  const onDragEnter = (e: React.DragEvent<HTMLDivElement>) => { e.preventDefault(); if (!uploading) setDragActive(true); };
  const onDragOver = (e: React.DragEvent<HTMLDivElement>) => { e.preventDefault(); if (!uploading) setDragActive(true); };
  const onDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    setDragActive(false);
  };
  const onDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragActive(false);
    if (uploading) return;
    const file = e.dataTransfer.files?.[0];
    if (!file) return;
    if (file.type && !accept.split(',').includes(file.type)) {
      toast(`Unsupported file type: ${file.type}`, 'error');
      return;
    }
    void handleFile(file);
  };

  const onFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) void handleFile(file);
  };

  if (value?.url) {
    const type = value.type ?? inferType(value.url);
    return (
      <div>
        <label style={labelStyle}>{label}</label>
        <div style={{ position: 'relative', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 10, overflow: 'hidden', background: 'rgba(255,255,255,0.02)' }}>
          {type === 'VIDEO' ? (
            <video src={value.url} controls style={{ width: '100%', maxHeight: boxHeight, display: 'block', background: '#000' }} />
          ) : type === 'DOCUMENT' ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 16px' }}>
              <div style={{ width: 36, height: 36, borderRadius: 8, background: 'rgba(212,175,55,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--gold)', flexShrink: 0 }}>
                <IcFile />
              </div>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: 12, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{value.filename}</div>
                {!!size && <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>{formatSize(size)}</div>}
              </div>
            </div>
          ) : (
            <img src={value.url} alt={value.filename ?? 'media'} style={{ width: '100%', maxHeight: boxHeight, objectFit: 'cover', display: 'block' }} />
          )}
          <button
            onClick={() => onChange(null)}
            style={{ position: 'absolute', top: 8, right: 8, background: 'rgba(0,0,0,0.6)', border: '1px solid rgba(255,255,255,0.15)', borderRadius: 6, padding: 6, cursor: 'pointer', color: '#fff', display: 'flex' }}
            title="Remove"
          >
            <IcX />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <label style={labelStyle}>{label}</label>
      <div
        onDragEnter={onDragEnter}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        onClick={() => inputRef.current?.click()}
        style={{
          border: `1.5px dashed ${dragActive ? 'var(--gold)' : 'rgba(255,255,255,0.12)'}`,
          borderRadius: 10,
          padding: compact ? '16px 12px' : '28px 20px',
          textAlign: 'center',
          cursor: uploading ? 'wait' : 'pointer',
          background: dragActive ? 'rgba(212,175,55,0.06)' : 'rgba(255,255,255,0.015)',
          transition: 'border-color 0.15s, background 0.15s',
        }}
      >
        <div style={{ color: dragActive ? 'var(--gold)' : 'var(--text-muted)', display: 'flex', justifyContent: 'center', marginBottom: 8 }}>
          <IcUpload />
        </div>
        <div style={{ fontSize: 12, color: dragActive ? 'var(--gold)' : 'var(--text-muted)' }}>
          {uploading
            ? 'Uploading…'
            : dragActive
              ? 'Drop to upload'
              : `Drag & drop or click to upload — image, video${allowDocument ? ', or document' : ''}`}
        </div>
        <input ref={inputRef} type="file" accept={accept} style={{ display: 'none' }} disabled={uploading} onChange={onFileInputChange} />
      </div>
    </div>
  );
}
