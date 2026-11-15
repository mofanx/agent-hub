import { useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { useHubStore } from "../../hub/store";
import { stringsFor, type Strings } from "../../hub/strings";
import type { PersonaCard, RoomInfo, RoomModeConfig, SessionInfo } from "../../hub/types";
import { FormRow } from "../../components/FormRow";

type RoomModeOption = { value: string; label: string; description: string };

const MAIN_MODES = ["auto", "mention", "conductor", "parallel"];
const ADV_MODES = ["roundrobin", "pipeline", "debate"];

function modeOptions(S: Strings): RoomModeOption[] {
  return [
    { value: "auto", label: S.rmAutoLabel, description: S.rmAutoDesc },
    { value: "mention", label: S.rmMentionLabel, description: S.rmMentionDesc },
    { value: "conductor", label: S.rmConductorLabel, description: S.rmConductorDesc },
    { value: "parallel", label: S.rmParallelLabel, description: S.rmParallelDesc },
    { value: "roundrobin", label: S.rmRoundrobinLabel, description: S.rmRoundrobinDesc },
    { value: "pipeline", label: S.rmPipelineLabel, description: S.rmPipelineDesc },
    { value: "debate", label: S.rmDebateLabel, description: S.rmDebateDesc },
  ];
}

const isAdvancedMode = (m: string) => ADV_MODES.includes(m);

export function RoomDialog({ onClose, editingRoom }: { onClose: () => void; editingRoom?: RoomInfo | null }) {
  const store = useHubStore();
  const S = stringsFor(store.lang);
  const modes = modeOptions(S);
  const editing = editingRoom;
  const isEdit = !!editing;
  const [form, setForm] = useState({
    name: editing?.name ?? "",
    mode: editing?.mode ?? "auto",
    selected: (editing?.members.map((m) => m[0]) ?? []) as string[],
    specialId:
      editing?.mode === "parallel"
        ? (editing?.parallelSummarizerId ?? "")
        : editing?.mode === "debate"
          ? (editing?.debateJudge ?? "")
          : (editing?.conductorId ?? ""),
    pipelineOrder: editing?.pipelineOrder ?? (editing?.members.map((m) => m[0]) ?? []),
    debateSides: (editing?.debateSides ?? ["", ""]) as [string, string],
    debateJudge: editing?.debateJudge ?? "",
    debateRounds: editing?.debateRounds ?? 2,
    memberRoles: (editing?.memberRoles ?? {}) as Record<string, string | PersonaCard>,
    maxConcurrent: editing?.maxConcurrent != null ? String(editing.maxConcurrent) : "",
    maxAgentCalls: editing?.maxAgentCalls != null ? String(editing.maxAgentCalls) : "",
    maxFlowDurationMin: editing?.maxFlowDurationMs != null ? String(editing.maxFlowDurationMs / 60000) : "",
    maxRounds: editing?.maxRounds != null ? String(editing.maxRounds) : "",
    relevanceFilter: (editing?.relevanceFilter === true ? "on" : editing?.relevanceFilter === false ? "off" : "global") as "global" | "on" | "off",
  });
  const [advOpen, setAdvOpen] = useState(isEdit && isAdvancedMode(editing?.mode ?? ""));

  const available = store.sessions.filter((s) => !s.archived);

  const selectedSessions = form.selected
    .map((id) => store.sessions.find((s) => s.sessionId === id))
    .filter((s): s is SessionInfo => !!s);

  const selectedOptions = selectedSessions.map((s) => (
    <option key={s.sessionId} value={s.sessionId}>
      {s.name}
    </option>
  ));

  const ensureDebateDefaults = (selected: string[]) => {
    const sides: [string, string] = [...form.debateSides];
    if (!sides[0] && selected[0]) sides[0] = selected[0];
    if (!sides[1] && selected[1]) sides[1] = selected[1];
    return sides;
  };

  const toggle = (id: string) => {
    const next = form.selected.includes(id)
      ? form.selected.filter((x) => x !== id)
      : [...form.selected, id];
    const nextOrder = form.pipelineOrder.filter((sid) => next.includes(sid));
    for (const sid of next) {
      if (!nextOrder.includes(sid)) nextOrder.push(sid);
    }
    const nextRoles = Object.fromEntries(
      Object.entries(form.memberRoles).filter(([sid]) => next.includes(sid)),
    );
    setForm({
      ...form,
      selected: next,
      specialId: next.includes(form.specialId) ? form.specialId : "",
      pipelineOrder: nextOrder,
      debateSides: ensureDebateDefaults(next),
      debateJudge: next.includes(form.debateJudge) ? form.debateJudge : "",
      memberRoles: nextRoles,
    });
  };

  const movePipeline = (index: number, dir: -1 | 1) => {
    const order = [...form.pipelineOrder];
    const target = index + dir;
    if (target < 0 || target >= order.length) return;
    [order[index], order[target]] = [order[target], order[index]];
    setForm({ ...form, pipelineOrder: order });
  };

  const needsSpecial = (m: string) =>
    m === "conductor" || m === "auto" || m === "roundrobin" || m === "parallel" || m === "debate";

  const isValid = (): boolean => {
    if (form.selected.length < (isEdit ? 1 : 2) || !form.name.trim()) return false;
    if (needsSpecial(form.mode) && !form.specialId && !form.selected[0]) return false;
    if (form.mode === "pipeline" && form.pipelineOrder.length === 0) return false;
    if (!limitsValid()) return false;
    return true;
  };

  const durationValue = (raw: string): number | null => {
    const ms = Math.round(Number(raw.trim()) * 60000);
    return Number.isSafeInteger(ms) && ms >= 1000 && Number.isSafeInteger(Date.now() + ms) ? ms : null;
  };

  const limitsValid = (): boolean => {
    const posInt = (s: string) => {
      if (s.trim() === "") return true;
      const n = Number(s);
      return Number.isSafeInteger(n) && n >= 1;
    };
    if (!posInt(form.maxConcurrent)) return false;
    if (!posInt(form.maxAgentCalls)) return false;
    if (!posInt(form.maxRounds)) return false;
    if (form.maxFlowDurationMin.trim() !== "" && durationValue(form.maxFlowDurationMin) === null) return false;
    return true;
  };

  const origNum = (v: number | null | undefined) => v ?? null;

  const numField = (
    raw: string,
    orig: number | null | undefined,
    toValue: (s: string) => number | null,
  ): number | null | undefined => {
    const t = raw.trim();
    const parsed = t === "" ? null : toValue(t);
    if (parsed === null && t !== "") return undefined;
    if (parsed !== null && (!Number.isFinite(parsed) || parsed <= 0)) return undefined;
    if (isEdit && parsed === origNum(orig)) return undefined;
    return parsed;
  };

  const submit = () => {
    if (!isValid()) return;
    const effectiveSpecial = form.specialId || form.selected[0] || "";
    const config: RoomModeConfig = {};
    if (effectiveSpecial) {
      if (form.mode === "conductor" || form.mode === "auto" || form.mode === "roundrobin") {
        config.conductorId = effectiveSpecial;
      } else if (form.mode === "parallel") {
        config.parallelSummarizerId = effectiveSpecial;
      } else if (form.mode === "debate") {
        config.debateJudge = effectiveSpecial;
      }
    }
    if (form.mode === "pipeline" && form.pipelineOrder.length > 0) {
      config.pipelineOrder = form.pipelineOrder;
    }
    if (form.mode === "debate") {
      if (form.debateSides[0] && form.debateSides[1]) {
        config.debateSides = form.debateSides;
      }
      config.debateRounds = Math.max(1, Math.min(5, form.debateRounds));
    }
    const mc = numField(form.maxConcurrent, editing?.maxConcurrent, (s) => {
      const n = Number(s);
      return Number.isSafeInteger(n) && n >= 1 ? n : null;
    });
    if (mc !== undefined) config.maxConcurrent = mc;
    const mac = numField(form.maxAgentCalls, editing?.maxAgentCalls, (s) => {
      const n = Number(s);
      return Number.isSafeInteger(n) && n >= 1 ? n : null;
    });
    if (mac !== undefined) config.maxAgentCalls = mac;
    const mfd = numField(form.maxFlowDurationMin, editing?.maxFlowDurationMs, (s) => durationValue(s));
    if (mfd !== undefined) config.maxFlowDurationMs = mfd;
    const mr = numField(form.maxRounds, editing?.maxRounds, (s) => {
      const n = Number(s);
      return Number.isSafeInteger(n) && n >= 1 ? n : null;
    });
    if (mr !== undefined) config.maxRounds = mr;
    const rfOrig = editing?.relevanceFilter ?? null;
    const rfVal = form.relevanceFilter === "on" ? true : form.relevanceFilter === "off" ? false : null;
    if (rfVal !== rfOrig) config.relevanceFilter = rfVal;
    if (isEdit && editing && form.mode !== editing.mode) {
      const activeKeys = new Set(
        form.mode === "conductor" || form.mode === "auto" || form.mode === "roundrobin"
          ? ["conductorId"]
          : form.mode === "parallel"
            ? ["parallelSummarizerId"]
            : form.mode === "pipeline"
              ? ["pipelineOrder"]
              : form.mode === "debate"
                ? ["debateSides", "debateJudge", "debateRounds"]
                : [],
      );
      for (const k of [
        "conductorId",
        "parallelSummarizerId",
        "pipelineOrder",
        "debateSides",
        "debateJudge",
        "debateRounds",
      ] as const) {
        if (!activeKeys.has(k) && !Object.prototype.hasOwnProperty.call(config, k)) {
          (config as Record<string, unknown>)[k] = null;
        }
      }
    }
    const memberRoles = Object.fromEntries(
      Object.entries(form.memberRoles).filter(([, v]) =>
        typeof v === "string" ? v.trim() : !!v?.persona?.trim(),
      ),
    ) as Record<string, string | PersonaCard>;
    const stableRole = (v: string | PersonaCard | undefined): string => {
      if (typeof v === "string") return JSON.stringify(v);
      if (v && typeof v === "object") {
        const o = v as Record<string, unknown>;
        return JSON.stringify(["persona", "tone", "boundaries", "examples"].map((k) => o[k] ?? ""));
      }
      return JSON.stringify(v);
    };
    const rolesEqual = (a: Record<string, string | PersonaCard>, b: Record<string, string | PersonaCard> | null | undefined): boolean => {
      const bk = Object.keys(b ?? {});
      const ak = Object.keys(a);
      return ak.length === bk.length && ak.every((k) => stableRole(a[k]) === stableRole(b?.[k]));
    };
    const rolesDirty = isEdit ? !rolesEqual(memberRoles, editing?.memberRoles) : true;
    if (isEdit && editing) {
      void store.updateRoom(editing, form.name, form.selected, form.mode, config, rolesDirty ? memberRoles : undefined);
    } else {
      void store.createRoom(form.name, form.selected, form.mode, config, memberRoles);
    }
    onClose();
  };

  const applyMode = (mode: string) => {
    setForm({
      ...form,
      mode,
      specialId: "",
      debateSides: ensureDebateDefaults(form.selected),
    });
  };

  const onModeChange = (mode: string) => applyMode(mode);

  const renderConfig = () => {
    switch (form.mode) {
      case "conductor":
      case "auto":
      case "roundrobin":
      case "parallel":
      case "debate": {
        const label =
          form.mode === "conductor"
            ? S.conductorLabel
            : form.mode === "auto"
              ? S.moderatorLabel
              : form.mode === "roundrobin"
                ? S.firstSpeakerLabel
                : form.mode === "parallel"
                  ? S.summarizerLabel
                  : S.judgeLabel;
        return (
          <FormRow label={label}>
            <select
              value={form.specialId || form.selected[0] || ""}
              onChange={(e) => setForm({ ...form, specialId: e.currentTarget.value })}
            >
              <option value="">{S.pleaseSelect}</option>
              {selectedOptions}
            </select>
          </FormRow>
        );
      }
      case "pipeline":
        return (
          <FormRow label={S.pipelineOrderLabel}>
            <div className="pipeline-order">
              {form.pipelineOrder.map((sid, i) => {
                const s = store.sessions.find((x) => x.sessionId === sid);
                if (!s) return null;
                return (
                  <div key={sid} className="pipeline-item">
                    <span className="pipeline-name">
                      {i + 1}. {s.name}
                    </span>
                    <div className="pipeline-actions">
                      <button
                        className="secondary icon-btn"
                        disabled={i === 0}
                        onClick={() => movePipeline(i, -1)}
                      >
                        <ChevronUp size={13} />
                      </button>
                      <button
                        className="secondary icon-btn"
                        disabled={i === form.pipelineOrder.length - 1}
                        onClick={() => movePipeline(i, 1)}
                      >
                        <ChevronDown size={13} />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </FormRow>
        );
      default:
        return null;
    }
  };

  const renderDebateConfig = () => {
    if (form.mode !== "debate") return null;
    return (
      <>
        <FormRow label={S.proSideLabel}>
          <select
            value={form.debateSides[0]}
            onChange={(e) =>
              setForm({
                ...form,
                debateSides: [e.currentTarget.value, form.debateSides[1]] as [string, string],
              })
            }
          >
            <option value="">{S.pleaseSelect}</option>
            {selectedOptions}
          </select>
        </FormRow>
        <FormRow label={S.conSideLabel}>
          <select
            value={form.debateSides[1]}
            onChange={(e) =>
              setForm({
                ...form,
                debateSides: [form.debateSides[0], e.currentTarget.value] as [string, string],
              })
            }
          >
            <option value="">{S.pleaseSelect}</option>
            {selectedOptions}
          </select>
        </FormRow>
        <FormRow label={S.roundsLabel}>
          <input
            type="number"
            min={1}
            max={5}
            value={form.debateRounds}
            onChange={(e) =>
              setForm({ ...form, debateRounds: Math.max(1, Math.min(5, Number(e.currentTarget.value) || 1)) })
            }
          />
        </FormRow>
      </>
    );
  };

  const mainModeOptions = modes.filter((m) => MAIN_MODES.includes(m.value) || m.value === form.mode);
  const modeInfo = modes.find((m) => m.value === form.mode);

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h3>{isEdit ? S.editRoomTitle : S.newRoomTitle}</h3>
        <FormRow label={S.nameLabel}>
          <input
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.currentTarget.value })}
          />
        </FormRow>
        <FormRow label={S.modeSection}>
          <select value={form.mode} onChange={(e) => onModeChange(e.currentTarget.value)}>
            {mainModeOptions.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        </FormRow>
        {modeInfo && <div className="mode-description">{modeInfo.description}</div>}

        {!isAdvancedMode(form.mode) && renderConfig()}
        {!isAdvancedMode(form.mode) && renderDebateConfig()}

        <details
          className="advanced-section"
          open={advOpen}
          onToggle={(e) => setAdvOpen(e.currentTarget.open)}
        >
          <summary>{S.advancedSectionLabel}</summary>
          <FormRow label={S.modeSection}>
            <select
              value={isAdvancedMode(form.mode) ? form.mode : ""}
              onChange={(e) => {
                if (e.currentTarget.value) {
                  applyMode(e.currentTarget.value);
                  setAdvOpen(true);
                }
              }}
            >
              <option value="">{S.advancedModePlaceholder}</option>
              {modes.filter((m) => ADV_MODES.includes(m.value)).map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </FormRow>
          {isAdvancedMode(form.mode) && modeInfo && (
            <div className="mode-description">{modeInfo.description}</div>
          )}
          {isAdvancedMode(form.mode) && renderConfig()}
          {isAdvancedMode(form.mode) && renderDebateConfig()}
          <div className="resource-section">
            <h4>{S.resourceSectionLabel}</h4>
            <div className="resource-hint">{S.resourceDefaultsHint}</div>
            <FormRow label={S.maxConcurrentLabel}>
              <input
                type="number"
                min={1}
                step={1}
                placeholder={S.unlimitedLabel}
                value={form.maxConcurrent}
                onChange={(e) => setForm({ ...form, maxConcurrent: e.currentTarget.value })}
              />
            </FormRow>
            <FormRow label={S.maxAgentCallsLabel}>
              <input
                type="number"
                min={1}
                step={1}
                placeholder={S.unlimitedLabel}
                value={form.maxAgentCalls}
                onChange={(e) => setForm({ ...form, maxAgentCalls: e.currentTarget.value })}
              />
            </FormRow>
            <FormRow label={S.maxFlowDurationLabel}>
              <input
                type="number"
                min={0}
                step="any"
                placeholder={S.unlimitedLabel}
                value={form.maxFlowDurationMin}
                onChange={(e) => setForm({ ...form, maxFlowDurationMin: e.currentTarget.value })}
              />
            </FormRow>
            <FormRow label={S.maxRoundsLabel}>
              <input
                type="number"
                min={1}
                step={1}
                placeholder={S.unlimitedLabel}
                value={form.maxRounds}
                onChange={(e) => setForm({ ...form, maxRounds: e.currentTarget.value })}
              />
            </FormRow>
            <FormRow label={S.relevanceFilterLabel}>
              <select
                value={form.relevanceFilter}
                onChange={(e) =>
                  setForm({ ...form, relevanceFilter: e.currentTarget.value as "global" | "on" | "off" })
                }
              >
                <option value="global">{S.relevanceFilterGlobal}</option>
                <option value="on">{S.relevanceFilterOn}</option>
                <option value="off">{S.relevanceFilterOff}</option>
              </select>
            </FormRow>
          </div>
        </details>

        <div className="member-picker">
          <h4>{S.pickMembersLabel}</h4>
          {available.map((s) => (
            <div key={s.sessionId} className="member-row">
              <label className="member-check">
                <input
                  type="checkbox"
                  checked={form.selected.includes(s.sessionId)}
                  onChange={() => toggle(s.sessionId)}
                />
                {store.displayName(s)}
              </label>
              {form.selected.includes(s.sessionId) && (
                <>
                  {(() => {
                    const v = form.memberRoles[s.sessionId];
                    const isCard = typeof v === "object" && v !== null;
                    const isLegacyText =
                      typeof v === "string" && v && !store.roles.some((r) => r.id === v);
                    const card: PersonaCard = isCard
                      ? v
                      : { persona: isLegacyText ? String(v) : "" };
                    const setCard = (f: keyof PersonaCard, val: string) => {
                      const next = { ...card, [f]: val };
                      const memberRoles = { ...form.memberRoles };
                      if (!next.persona?.trim() && !next.tone?.trim() && !next.boundaries?.trim() && !next.examples?.trim()) {
                        delete memberRoles[s.sessionId];
                      } else {
                        memberRoles[s.sessionId] = next;
                      }
                      setForm({ ...form, memberRoles });
                    };
                    return (
                      <>
                        <select
                          className="role-select"
                          value={isCard || isLegacyText ? "__persona__" : (v ?? "")}
                          onChange={(e) => {
                            const val = e.currentTarget.value;
                            const memberRoles = { ...form.memberRoles };
                            if (val === "__persona__") memberRoles[s.sessionId] = card;
                            else if (val) memberRoles[s.sessionId] = val;
                            else delete memberRoles[s.sessionId];
                            setForm({ ...form, memberRoles });
                          }}
                        >
                          <option value="">{S.defaultRoleLabel}</option>
                          {store.roles.map((r) => (
                            <option key={r.id} value={r.id}>
                              {r.name}
                            </option>
                          ))}
                          <option value="__persona__">{S.personaCardOption}</option>
                        </select>
                        {(isCard || isLegacyText) && (
                          <div className="persona-card-form">
                            {(["persona", "tone", "boundaries", "examples"] as const).map((f) => (
                              <input
                                key={f}
                                className="persona-field"
                                placeholder={
                                  f === "persona"
                                    ? S.personaFieldPersona
                                    : f === "tone"
                                      ? S.personaFieldTone
                                      : f === "boundaries"
                                        ? S.personaFieldBoundaries
                                        : S.personaFieldExamples
                                }
                                value={card[f] ?? ""}
                                onChange={(e) => setCard(f, e.currentTarget.value)}
                              />
                            ))}
                          </div>
                        )}
                      </>
                    );
                  })()}
                </>
              )}
            </div>
          ))}
        </div>

        <div className="form-actions">
          <button className="secondary" onClick={onClose}>
            {S.cancelLabel}
          </button>
          <button className="primary" onClick={submit} disabled={!isValid()}>
            {isEdit ? S.saveLabel : S.createLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
