import { useState } from "react";
import { useHubStore } from "../hub/store";
import { stringsFor } from "../hub/strings";
import type { OutboxSummary } from "../hub/types";

export function OutboxPanel() {
  const store = useHubStore();
  const S = stringsFor(store.lang);
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [copyFailed, setCopyFailed] = useState<string | null>(null);
  const entries = store.outboxEntries;
  if (!entries.length) return null;
  const statusText = (st: OutboxSummary["status"]) =>
    st === "pending" ? S.sendStatusPending :
    st === "sending" ? S.sendStatusSending :
    st === "uncertain" ? S.sendStatusUncertain : S.sendStatusFailed;
  return (
    <div className="outbox-panel">
      <button
        className="link outbox-toggle"
        aria-expanded={open}
        aria-controls="outbox-list"
        onClick={() => setOpen(!open)}
      >
        {S.outboxRecordsFmt.replace("%d", String(entries.length))}
      </button>
      {open && (
        <div id="outbox-list" className="outbox-list">
          {entries.map((e) => (
            <div key={e.clientMessageId} className="outbox-row">
              <div className="outbox-row-meta">
                <span>{e.profileLabel || S.outboxUnknownProfile}</span>
                <span className="dim">{(() => { const d = new Date(e.queuedAt); return Number.isNaN(d.getTime()) ? "" : d.toLocaleString(store.lang === "zh" ? "zh-CN" : "en"); })()}</span>
                <span className="dim">{e.scopeLabel || S.outboxUnknownScope}</span>
                <span className={`send-status-${e.status}`}>{statusText(e.status)}</span>
              </div>
              <div className="outbox-row-text">{e.text.slice(0, 300)}</div>
              {e.attachmentNames.length > 0 && (
                <div className="send-status-hint">
                  {S.outboxAttachmentNamesFmt.replace("%s", e.attachmentNames.join(", "))}
                </div>
              )}
              {!e.current && <div className="send-status-hint">{S.outboxOtherConnection}</div>}
              {e.status === "uncertain" && <div className="send-status-hint">{S.sendUncertainHint}</div>}
              <div className="outbox-row-actions">
                <button className="link" onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(e.text);
                    setCopied(e.clientMessageId); setCopyFailed(null);
                  } catch {
                    setCopyFailed(e.clientMessageId); setCopied(null);
                  }
                }}>{copied === e.clientMessageId ? S.copied : S.copy}</button>
                {copyFailed === e.clientMessageId && <span className="send-status-hint">{S.outboxCopyFailed}</span>}
                {e.status !== "sending" && (
                  <button className="link" onClick={() => {
                    if (!window.confirm(S.outboxRemoveConfirm)) return;
                    store.dismissOutgoing(e.clientMessageId, true);
                  }}>{S.dismissOutgoing}</button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
