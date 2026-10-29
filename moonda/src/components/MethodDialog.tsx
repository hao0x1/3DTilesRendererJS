import { useEffect, useRef } from 'react';
import { X } from '@phosphor-icons/react';
import type { ReactNode } from 'react';

export default function MethodDialog({ open, onClose, children }: { open: boolean; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (open && !ref.current?.open) ref.current?.showModal();
    if (!open && ref.current?.open) ref.current.close();
  }, [open]);
  return <dialog className="modal mission-method-dialog" ref={ref} aria-label="NASA data and model assumptions" onCancel={onClose} onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="modal-header"><div><span className="eyebrow">MOONDA / SOURCES</span><h2>Data and model assumptions</h2></div><button className="icon-button" aria-label="Close data and model assumptions" onClick={onClose}><X size={20} /></button></div>
    <div className="modal-body">{children}</div>
  </dialog>;
}
