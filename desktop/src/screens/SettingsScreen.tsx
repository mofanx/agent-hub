import { useState } from "react";
import { Bot, Copy, Drama, ExternalLink, LogOut, RefreshCw, Settings2 } from "lucide-react";
import { useHubStore } from "../hub/store";
import { stringsFor } from "../hub/strings";
import type { ConnectionInfo, RoleInfo } from "../hub/types";
import { version } from "../../package.json";
import { FormRow } from "../components/FormRow";

type Tab = "general" | "connections" | "roles";

export function SettingsScreen() {
  const store = useHubStore();
  const S = stringsFor(store.lang);
  const [tab, setTab] = useState<Tab>("general");

  return (
    <div className="settings-screen">
      <nav className="settings-nav">
        <div className="nav-heading">{S.settingsTitle}</div>
        <button className={tab === "general" ? "active" : ""} onClick={() => setTab("general")}>
          <Settings2 size={15} /> {S.generalTab}
        </button>
        <button className={tab === "connections" ? "active" : ""} onClick={() => setTab("connections")}>
          <Bot size={15} /> {S.agentSources}
        </button>
        <button className={tab === "roles" ? "active" : ""} onClick={() => setTab("roles")}>
          <Drama size={15} /> {S.rolesTab}
        </button>
        <span className="spacer" />
        <button onClick={() => void store.refreshAll()}>
          <RefreshCw size={15} /> {S.refreshStatus}
        </button>
        <button className="danger" onClick={store.disconnect}>
          <LogOut size={15} /> {S.disconnectLabel}
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
  const S = stringsFor(lang);
  return (
    <>
      <div className="card">
        <h3>{S.themeSection}</h3>
        <p className="card-desc">{S.themeDesc}</p>
        <div className="seg-control">
          {(["system", "light", "dark"] as const).map((m) => (
            <button
              key={m}
              className={themeMode === m ? "active" : ""}
              onClick={() => useHubStore.getState().updateThemeMode(m)}
            >
              {m === "system" ? S.themeSystem : m === "light" ? S.themeLight : S.themeDark}
            </button>
          ))}
        </div>
      </div>

      <div className="card">
        <h3>{S.langSection}</h3>
        <p className="card-desc">{S.langDesc}</p>
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
        <h3>{S.sendKeySection}</h3>
        <p className="card-desc">{S.sendKeyDesc}</p>
        <div className="seg-control">
          {[
            { key: "enter" as const, label: S.sendKeyEnter },
            { key: "ctrl-enter" as const, label: S.sendKeyCtrlEnter },
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
        <h3>{S.bypassSection}</h3>
        <p className="card-desc">{S.bypassDesc}</p>
        <div className="seg-control">
          <button onClick={() => toggleBypass("on")}>{S.onLabel}</button>
          <button onClick={() => toggleBypass("off")}>{S.offLabel}</button>
        </div>
      </div>

      <div className="card">
        <h3>{S.aboutSection}</h3>
        <p className="card-desc">{S.aboutDescFmt.replace("%s", version)}</p>
        <button onClick={() => window.open("https://github.com/mofanx/agent-hub", "_blank")}>
          <ExternalLink size={14} /> {S.openRepo}
        </button>
      </div>
    </>
  );
}

function ConnectionsSettings() {
  const store = useHubStore();
  const S = stringsFor(store.lang);
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
          {S.addAgentSource}
        </button>
      ) : (
        <div className="card">
          <h3>{S.addAgentSource}</h3>
          <FormRow label={S.nameLabel}>
            <input value={form.name ?? ""} onChange={(e) => setForm({ ...form, name: e.currentTarget.value })} />
          </FormRow>
          <FormRow label={S.typeLabel}>
            <select value={form.agent ?? "devin"} onChange={(e) => setForm({ ...form, agent: e.currentTarget.value })}>
              {["devin", "claude", "codex", "opencode", "openclaw"].map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          </FormRow>
          <FormRow label={S.hubAddressLabel}>
            <input value={form.address ?? ""} onChange={(e) => setForm({ ...form, address: e.currentTarget.value })} />
          </FormRow>
          <FormRow label={S.cwdSection}>
            <input value={form.cwd ?? ""} onChange={(e) => setForm({ ...form, cwd: e.currentTarget.value })} />
          </FormRow>
          <FormRow label="Token">
            <input value={form.token ?? ""} onChange={(e) => setForm({ ...form, token: e.currentTarget.value })} />
          </FormRow>
          <FormRow label={S.localStartLabel}>
            <select value={form.local ?? "false"} onChange={(e) => setForm({ ...form, local: e.currentTarget.value })}>
              <option value="false">{S.noLabel}</option>
              <option value="true">{S.yesLabel}</option>
            </select>
          </FormRow>
          <div className="form-actions">
            <button className="secondary" onClick={() => setShowAdd(false)}>
              {S.cancelLabel}
            </button>
            <button className="primary" onClick={submit}>{S.createLabel}</button>
          </div>
        </div>
      )}
    </>
  );
}

function ConnectionCard({ c }: { c: ConnectionInfo }) {
  const store = useHubStore();
  const S = stringsFor(store.lang);
  const badge = c.error ? (
    <span className="status-badge err">{S.startFailed}</span>
  ) : c.local ? (
    <span className="status-badge local">{S.localTag}</span>
  ) : c.online ? (
    <span className="status-badge ok">{S.statusOnline}</span>
  ) : (
    <span className="status-badge off">{S.statusOffline}</span>
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
          {S.deleteLabel}
        </button>
      </div>
      <div className="card-meta">
        {c.local ? S.localLaunch : `Token: ${c.token}`}
        {c.address && ` · ${c.address}`}
        {c.cwd && ` · ${c.cwd}`}
      </div>
      {c.error && <div className="error">{S.startFailedFmt.replace("%s", c.error)}</div>}
      {!c.local && (
        <div>
          <button className="secondary tiny" onClick={() => void navigator.clipboard.writeText(c.token)}>
            <Copy size={11} /> {S.copyToken}
          </button>
        </div>
      )}
    </div>
  );
}

function RolesSettings() {
  const store = useHubStore();
  const S = stringsFor(store.lang);
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
          {S.addRole}
        </button>
      ) : (
        <div className="card">
          <h3>{S.addRole}</h3>
          <FormRow label={S.nameLabel}>
            <input value={form.name ?? ""} onChange={(e) => setForm({ ...form, name: e.currentTarget.value })} />
          </FormRow>
          <FormRow label={S.personaLabel}>
            <textarea
              value={form.persona ?? ""}
              onChange={(e) => setForm({ ...form, persona: e.currentTarget.value })}
              rows={4}
            />
          </FormRow>
          <FormRow label={S.cwdSection}>
            <input value={form.cwd ?? ""} onChange={(e) => setForm({ ...form, cwd: e.currentTarget.value })} />
          </FormRow>
          <FormRow label={S.connectionLabel}>
            <select
              value={form.connectionId ?? ""}
              onChange={(e) => setForm({ ...form, connectionId: e.currentTarget.value })}
            >
              <option value="">{S.optionalLabel}</option>
              {store.connections.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </FormRow>
          <div className="form-actions">
            <button className="secondary" onClick={() => setShowAdd(false)}>
              {S.cancelLabel}
            </button>
            <button className="primary" onClick={submit}>{S.createLabel}</button>
          </div>
        </div>
      )}
    </>
  );
}

function RoleCard({ r }: { r: RoleInfo }) {
  const store = useHubStore();
  const S = stringsFor(store.lang);
  return (
    <div className="card role-card">
      <div className="card-head">
        <span className="card-title">
          {r.name} {r.builtin && <span className="status-badge off">{S.builtinBadge}</span>}
        </span>
        {!r.builtin && (
          <button className="danger tiny" onClick={() => void store.deleteRole(r.id)}>
            {S.deleteLabel}
          </button>
        )}
      </div>
      <div className="card-meta persona">{r.persona}</div>
      {r.cwd && <div className="card-meta">{S.defaultCwdFmt.replace("%s", r.cwd)}</div>}
    </div>
  );
}
