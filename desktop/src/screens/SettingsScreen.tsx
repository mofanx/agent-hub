import { useState } from "react";
import { Bot, Copy, Drama, ExternalLink, LogOut, RefreshCw, Settings2 } from "lucide-react";
import { useHubStore } from "../hub/store";
import type { ConnectionInfo, RoleInfo } from "../hub/types";
import { version } from "../../package.json";
import { FormRow } from "../components/FormRow";

type Tab = "general" | "connections" | "roles";

export function SettingsScreen() {
  const store = useHubStore();
  const [tab, setTab] = useState<Tab>("general");

  return (
    <div className="settings-screen">
      <nav className="settings-nav">
        <div className="nav-heading">设置</div>
        <button className={tab === "general" ? "active" : ""} onClick={() => setTab("general")}>
          <Settings2 size={15} /> 通用
        </button>
        <button className={tab === "connections" ? "active" : ""} onClick={() => setTab("connections")}>
          <Bot size={15} /> Agent 来源
        </button>
        <button className={tab === "roles" ? "active" : ""} onClick={() => setTab("roles")}>
          <Drama size={15} /> 角色
        </button>
        <span className="spacer" />
        <button onClick={() => void store.refreshAll()}>
          <RefreshCw size={15} /> 刷新状态
        </button>
        <button className="danger" onClick={store.disconnect}>
          <LogOut size={15} /> 断开连接
        </button>
      </nav>

      <div className="settings-content">
        <div className="settings-inner">
          {tab === "general" && <GeneralSettings />}
          {tab === "connections" && <ConnectionsSettings />}
          {tab === "roles" && <RolesSettings />}
        </div>
      </div>
    </div>
  );
}

function GeneralSettings() {
  const { themeMode, lang, sendKey, toggleBypass } = useHubStore();
  return (
    <>
      <div className="card">
        <h3>主题</h3>
        <p className="card-desc">界面外观，默认跟随系统</p>
        <div className="seg-control">
          {(["system", "light", "dark"] as const).map((m) => (
            <button
              key={m}
              className={themeMode === m ? "active" : ""}
              onClick={() => useHubStore.getState().updateThemeMode(m)}
            >
              {m === "system" ? "跟随系统" : m === "light" ? "浅色" : "深色"}
            </button>
          ))}
        </div>
      </div>

      <div className="card">
        <h3>语言</h3>
        <p className="card-desc">界面语言</p>
        <div className="seg-control">
          {[
            { key: "zh", label: "中文" },
            { key: "en", label: "English" },
          ].map(({ key, label }) => (
            <button
              key={key}
              className={lang === key ? "active" : ""}
              onClick={() => useHubStore.getState().updateLang(key)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="card">
        <h3>发送快捷键</h3>
        <p className="card-desc">发送消息的快捷键</p>
        <div className="seg-control">
          {[
            { key: "enter" as const, label: "Enter 发送" },
            { key: "ctrl-enter" as const, label: "Ctrl+Enter 发送" },
          ].map(({ key, label }) => (
            <button
              key={key}
              className={sendKey === key ? "active" : ""}
              onClick={() => useHubStore.getState().updateSendKey(key)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="card">
        <h3>权限绕过</h3>
        <p className="card-desc">开启后自动审批工具调用请求</p>
        <div className="seg-control">
          <button onClick={() => toggleBypass("on")}>开启</button>
          <button onClick={() => toggleBypass("off")}>关闭</button>
        </div>
      </div>

      <div className="card">
        <h3>关于</h3>
        <p className="card-desc">Agent Hub 桌面端 · 版本 {version}</p>
        <button onClick={() => window.open("https://github.com/mofanx/agent-hub", "_blank")}>
          <ExternalLink size={14} /> 打开仓库
        </button>
      </div>
    </>
  );
}

function ConnectionsSettings() {
  const store = useHubStore();
  const [form, setForm] = useState<Record<string, string>>({
    agent: "devin",
    local: "false",
  });
  const [showAdd, setShowAdd] = useState(false);

  const submit = () => {
    const { name, agent, address, cwd, token, local } = form;
    if (!name || !agent) return;
    void store.createConnection(name, agent, address || "", cwd || "", token || "", local === "true");
    setShowAdd(false);
    setForm({ agent: "devin", local: "false" });
  };

  return (
    <>
      {store.connections.map((c) => (
        <ConnectionCard key={c.id} c={c} />
      ))}

      {!showAdd ? (
        <button onClick={() => setShowAdd(true)} style={{ alignSelf: "flex-start" }}>
          ＋ 添加 Agent 来源
        </button>
      ) : (
        <div className="card">
          <h3>添加 Agent 来源</h3>
          <FormRow label="名称">
            <input value={form.name ?? ""} onChange={(e) => setForm({ ...form, name: e.currentTarget.value })} />
          </FormRow>
          <FormRow label="类型">
            <select value={form.agent ?? "devin"} onChange={(e) => setForm({ ...form, agent: e.currentTarget.value })}>
              {["devin", "claude", "codex", "opencode"].map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          </FormRow>
          <FormRow label="地址">
            <input value={form.address ?? ""} onChange={(e) => setForm({ ...form, address: e.currentTarget.value })} />
          </FormRow>
          <FormRow label="工作目录">
            <input value={form.cwd ?? ""} onChange={(e) => setForm({ ...form, cwd: e.currentTarget.value })} />
          </FormRow>
          <FormRow label="Token">
            <input value={form.token ?? ""} onChange={(e) => setForm({ ...form, token: e.currentTarget.value })} />
          </FormRow>
          <FormRow label="本地启动">
            <select value={form.local ?? "false"} onChange={(e) => setForm({ ...form, local: e.currentTarget.value })}>
              <option value="false">否</option>
              <option value="true">是</option>
            </select>
          </FormRow>
          <div className="form-actions">
            <button className="secondary" onClick={() => setShowAdd(false)}>
              取消
            </button>
            <button className="primary" onClick={submit}>创建</button>
          </div>
        </div>
      )}
    </>
  );
}

function ConnectionCard({ c }: { c: ConnectionInfo }) {
  const store = useHubStore();
  const badge = c.error ? (
    <span className="status-badge err">启动失败</span>
  ) : c.local ? (
    <span className="status-badge local">本机</span>
  ) : c.online ? (
    <span className="status-badge ok">在线</span>
  ) : (
    <span className="status-badge off">离线</span>
  );
  return (
    <div className="card connection-card">
      <div className="card-head">
        <span className="card-title">
          <span
            className="dot"
            style={{
              background: c.error ? "var(--danger)" : c.local ? "var(--info)" : c.online ? "var(--success)" : "var(--muted)",
            }}
          />
          {c.name} · {c.agent} {badge}
        </span>
        <button className="danger tiny" onClick={() => void store.deleteConnection(c.id)}>
          删除
        </button>
      </div>
      <div className="card-meta">
        {c.local ? "本地直接启动" : `Token: ${c.token}`}
        {c.address && ` · ${c.address}`}
        {c.cwd && ` · ${c.cwd}`}
      </div>
      {c.error && <div className="error">启动失败: {c.error}</div>}
      {!c.local && (
        <div>
          <button className="secondary tiny" onClick={() => void navigator.clipboard.writeText(c.token)}>
            <Copy size={11} /> 复制 Token
          </button>
        </div>
      )}
    </div>
  );
}

function RolesSettings() {
  const store = useHubStore();
  const [form, setForm] = useState<Record<string, string>>({});
  const [showAdd, setShowAdd] = useState(false);

  const submit = () => {
    const { name, persona, cwd, connectionId } = form;
    if (!name || !persona) return;
    void store.createRole(name, persona, cwd || "", connectionId || undefined);
    setShowAdd(false);
    setForm({});
  };

  return (
    <>
      {store.roles.map((r) => (
        <RoleCard key={r.id} r={r} />
      ))}

      {!showAdd ? (
        <button onClick={() => setShowAdd(true)} style={{ alignSelf: "flex-start" }}>
          ＋ 添加角色
        </button>
      ) : (
        <div className="card">
          <h3>添加角色</h3>
          <FormRow label="名称">
            <input value={form.name ?? ""} onChange={(e) => setForm({ ...form, name: e.currentTarget.value })} />
          </FormRow>
          <FormRow label="人设">
            <textarea
              value={form.persona ?? ""}
              onChange={(e) => setForm({ ...form, persona: e.currentTarget.value })}
              rows={4}
            />
          </FormRow>
          <FormRow label="工作目录">
            <input value={form.cwd ?? ""} onChange={(e) => setForm({ ...form, cwd: e.currentTarget.value })} />
          </FormRow>
          <FormRow label="连接">
            <select
              value={form.connectionId ?? ""}
              onChange={(e) => setForm({ ...form, connectionId: e.currentTarget.value })}
            >
              <option value="">可选</option>
              {store.connections.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </FormRow>
          <div className="form-actions">
            <button className="secondary" onClick={() => setShowAdd(false)}>
              取消
            </button>
            <button className="primary" onClick={submit}>创建</button>
          </div>
        </div>
      )}
    </>
  );
}

function RoleCard({ r }: { r: RoleInfo }) {
  const store = useHubStore();
  return (
    <div className="card role-card">
      <div className="card-head">
        <span className="card-title">
          {r.name} {r.builtin && <span className="status-badge off">内置</span>}
        </span>
        {!r.builtin && (
          <button className="danger tiny" onClick={() => void store.deleteRole(r.id)}>
            删除
          </button>
        )}
      </div>
      <div className="card-meta persona">{r.persona}</div>
      {r.cwd && <div className="card-meta">默认目录: {r.cwd}</div>}
    </div>
  );
}
