import { useRef, useState } from 'react';
import { Check, Copy, Download, ExternalLink, Image as ImageIcon, QrCode } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { Modal } from '../../../components/overlay';
import { Button } from '../../../components/primitives';
import { t } from '../../../lib/i18n';
import { copyText } from '../../../lib/clipboard';
import { useUi } from '../../../store/ui';
import { QR_BG_COLOR, QR_FG_COLOR } from '../../attachment-hub/qr-colors';
import { copyQrImageToClipboard, downloadQrPng, downloadQrSvg, qrFileName } from './qr-export';

const MODAL_WIDTH = 420;

/**
 * The code is drawn at 240 on screen and exported at 800 px: the first is read off a monitor across a
 * table, the second survives being printed on a flyer. Level M rather than H because a link is short
 * text, and the fewer modules a code has, the further away a camera can be and still read it.
 */
const ON_SCREEN_SIZE = 240;
const EXPORT_PX = 800;
const COPY_FEEDBACK_MS = 1600;

export interface ShareQrModalProps {
  url: string;
  title: string;
  onClose: () => void;
}

/**
 * The link as a code a camera can read, with every way out of this panel pointing at the same URL.
 *
 * The plate stays white in both themes: the code itself is painted on fixed white, and a dark frame
 * would cut into the quiet zone the scanner needs around it.
 */
export function ShareQrModal({ url, title, onClose }: ShareQrModalProps) {
  const toast = useUi((s) => s.toast);
  const [copiedLink, setCopiedLink] = useState(false);
  const [copiedImage, setCopiedImage] = useState(false);
  const plateRef = useRef<HTMLDivElement>(null);
  // The reader may have opened this from a relative link the hub handed out; a code has to carry the
  // address a camera can follow, so it is resolved against the site it is being photographed in.
  const absoluteUrl = toAbsoluteUrl(url);
  const svgOf = () => plateRef.current?.querySelector('svg') ?? null;

  async function copyLink() {
    if (!(await copyText(absoluteUrl))) {
      toast({ title: t('preview.could_not_copy'), tone: 'danger' });
      return;
    }
    flash(setCopiedLink);
  }

  async function copyImage() {
    const svg = svgOf();
    if (!svg) return;
    if (!(await copyQrImageToClipboard(svg))) {
      toast({ title: t('share.qr_copy_image_failed'), tone: 'danger' });
      return;
    }
    flash(setCopiedImage);
  }

  async function savePng() {
    const svg = svgOf();
    if (!svg) return;
    if (!(await downloadQrPng(svg, qrFileName(title, 'png'), EXPORT_PX))) {
      toast({ title: t('share.qr_download_failed'), tone: 'danger' });
    }
  }

  function saveSvg() {
    const svg = svgOf();
    if (!svg) return;
    downloadQrSvg(svg, qrFileName(title, 'svg'));
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={(
        <span className="flex items-center gap-1.5">
          <QrCode size={15} className="text-[var(--accent)]"/>
          {t('share.qr_title')}
        </span>
      )}
      description={title || t('common.untitled_note')}
      width={MODAL_WIDTH}
    >
      <div className="flex flex-col items-center gap-4 py-2">
        <div
          ref={plateRef}
          className="rounded-[var(--r-xl)] border border-[var(--border-default)] bg-white p-4 shadow-[var(--shadow-soft)]"
        >
          <QRCodeSVG
            value={absoluteUrl}
            size={ON_SCREEN_SIZE}
            level="M"
            marginSize={1}
            bgColor={QR_BG_COLOR}
            fgColor={QR_FG_COLOR}
            title={t('share.qr_title')}
          />
        </div>
        <p className="max-w-full truncate text-center font-mono text-[length:var(--text-12)] text-[var(--text-secondary)]">
          {absoluteUrl}
        </p>
        <p className="max-w-xs text-center text-[length:var(--text-11-5)] leading-relaxed text-[var(--text-tertiary)]">
          {t('share.qr_hint')}
        </p>
        <div className="grid w-full grid-cols-2 gap-2 pt-1">
          <Button
            size="sm"
            variant="secondary"
            icon={copiedLink ? <Check size={13} className="text-[var(--success)]"/> : <Copy size={13}/>}
            onClick={() => void copyLink()}
          >
            {copiedLink ? t('common.copied') : t('common.copy')}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            icon={copiedImage ? <Check size={13} className="text-[var(--success)]"/> : <ImageIcon size={13}/>}
            onClick={() => void copyImage()}
          >
            {copiedImage ? t('share.qr_copied_image') : t('share.qr_copy_image')}
          </Button>
          <Button size="sm" variant="secondary" icon={<Download size={13}/>} onClick={() => void savePng()}>
            {t('share.qr_download_png')}
          </Button>
          <Button size="sm" variant="secondary" icon={<Download size={13}/>} onClick={saveSvg}>
            {t('share.qr_download_svg')}
          </Button>
        </div>
        <a
          href={absoluteUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex h-9 w-full items-center justify-center gap-1.5 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-3 text-[length:var(--text-12)] font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
        >
          <ExternalLink size={13}/>
          {t('preview.open_in_new_tab')}
        </a>
      </div>
    </Modal>
  );
}

function toAbsoluteUrl(url: string): string {
  if (typeof window === 'undefined') return url;
  try {
    return new URL(url, window.location.origin).href;
  }
  catch {
    // Nothing to resolve against — an empty address draws no code, and the panel still shows the
    // copy and open actions for whatever the caller did hand over.
    return url;
  }
}

function flash(set: (value: boolean) => void) {
  set(true);
  window.setTimeout(() => set(false), COPY_FEEDBACK_MS);
}
