import { useEffect, useMemo, useState } from "react";
import { Globe, Laptop, Pencil, PlugZap, Trash2 } from "lucide-react";
import { useHubStore } from "../hub/store";
import type { ConnProfile } from "../hub/types";
import { FormRow } from "../components/FormRow";

function profileKey(p: ConnProfile) {
  return p.address;
}

function isRemote(p: ConnProfile) {
  return p.address.startsWith("wss://") || p.address.startsWith("https://");
}

export function HubConfigScreen() {
  const store = useHubStore();
  const [name, setName] = useState("");
  const [host, setHost] = useState("");
  const [token, setToken] = useState("dev-token");
  const [editing, setEditing] = useState<ConnProfile | null>(null);

  const last = useMemo(() => {
    const p = store.currentProfile;
    if (p) return p;
    return store.profiles[store.profiles.length - 1];
  }, [store.currentProfile, store.profiles]);

  useEffect(() => {
    if (last) {
      setName(last.name);
      setHost(last.address);
      setToken(last.token);
      setEditing(null);
    }
  }, [last]);

  const reset = () => {
    setName("");
    setHost("");
    setToken("dev-token");
    setEditing(null);
  };

  const fill = (p: ConnProfile, edit = false) => {
    setName(p.name);
    setHost(p.address);
    setToken(p.token);
    setEditing(edit ? p : null);
  };

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (editing && profileKey(editing) !== host) {
      store.deleteProfile(editing);
    }
    store.connect(host, token, trimmed);
  };

  const onDelete = (p: ConnProfile) => {
    store.deleteProfile(p);
    if (editing && profileKey(editing) === profileKey(p)) reset();
  };

  return (
    <div className="connect-screen">
      <div className="connect-brand">
        <img src="/logo.svg" alt="Agent Hub" />
        <h1>Agent Hub</h1>
        <p>连接一个 Hub，统一调度你的所有 Agent</p>
      </div>

      <div className="card connect-card">
        <h2>{editing ? "编辑 Hub 配置" : "添加 / 连接 Hub"}</h2>
        <form onSubmit={onSubmit}>
          <FormRow label="名称">
            <input
              value={name}
              onChange={(e) => setName(e.currentTarget.value)}
              placeholder="例如 本机 / 公网 VPS"
              required
            />
          </FormRow>
          <FormRow label="地址">
            <input
              value={host}
              onChange={(e) => setHost(e.currentTarget.value)}
              placeholder="例如 localhost:8787 或 wss://hub.example.com"
              required
            />
          </FormRow>
          <FormRow label="Token">
            <input
              value={token}
              onChange={(e) => setToken(e.currentTarget.value)}
              placeholder="HUB_TOKEN"
              required
            />
          </FormRow>
          {store.connectError && <div className="error">{store.connectError}</div>}
          <div className="form-actions">
            {editing && (
              <button type="button" className="secondary" onClick={reset}>
                取消编辑
              </button>
            )}
            <button type="submit" className="primary" disabled={store.connecting}>
              {store.connecting ? "连接中…" : editing ? "保存并连接" : "添加并连接"}
            </button>
          </div>
        </form>
      </div>

      {store.profiles.length > 0 && (
        <div className="card connect-card">
          <h3>已保存的 Hub</h3>
          <div className="profile-list">
            {store.profiles.map((p) => {
              const active = store.currentProfile && profileKey(store.currentProfile) === profileKey(p);
              return (
                <div key={profileKey(p)} className={`profile-item ${active ? "selected" : ""}`}>
                  <span className="profile-icon">{isRemote(p) ? <Globe size={15} /> : <Laptop size={15} />}</span>
                  <div className="title-wrap">
                    <span className="title">{p.name}</span>
                    <span className="subtitle">
                      {isRemote(p) ? "远程 (wss)" : "局域网"} · {p.address}
                    </span>
                  </div>
                  <div className="actions" onClick={(e) => e.stopPropagation()}>
                    <button className="icon-btn" title="编辑" onClick={() => fill(p, true)}>
                      <Pencil size={13} />
                    </button>
                    <button
                      className="icon-btn"
                      title="连接"
                      onClick={() => store.switchProfile(p)}
                      disabled={!!active}
                    >
                      <PlugZap size={13} />
                    </button>
                    <button className="icon-btn danger" title="删除" onClick={() => onDelete(p)}>
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
