import { useEffect, useMemo, useRef, useState } from "react";
import type {
  LlmSettings,
  ModelProfile,
  ProviderProfile,
  Snapshot,
  ThinkingEffort,
  TranslationSettings,
} from "./shared/types";
import { DEFAULT_MAX_DOCK_GROUPS, normalizeMaxDockGroups } from "./shared/types";
import { defaultModelProfile, defaultProviderProfile } from "./shared/models";
import { DEFAULT_TRANSLATION_SETTINGS } from "./shared/translation";
import { formatError } from "./shared/copy";
import { GitSettingsPanel } from "./git/ui/GitPanels";

type SettingsSection =
  | "models"
  | "interface"
  | "translation"
  | "git"
  | "plugins"
  | "mcp"
  | "skills"
  | "team";

const SECTIONS: Array<{ id: SettingsSection; label: string; hint: string }> = [
  { id: "models", label: "模型", hint: "供应商、模型与参数" },
  { id: "interface", label: "界面", hint: "Dock 分栏与布局" },
  { id: "translation", label: "翻译", hint: "思考机翻源" },
  { id: "git", label: "Git", hint: "分支、worktree 与合并" },
  { id: "plugins", label: "插件", hint: "扩展与工具集" },
  { id: "mcp", label: "MCP", hint: "外部工具服务器" },
  { id: "skills", label: "Skills", hint: "可复用能力包" },
  { id: "team", label: "团队", hint: "默认模型与成员" },
];

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1000) return `${Math.round(value / 1000)}k`;
  return String(value);
}

export default function SettingsView({
  snapshot,
  busy,
  onSave,
  onDirtyChange,
  onReload,
  initialSection,
}: {
  snapshot: Snapshot;
  busy: boolean;
  onSave: (settings: LlmSettings) => Promise<{ ok: true } | { ok: false; error: string }>;
  onDirtyChange?: (dirty: boolean) => void;
  onReload: () => void;
  initialSection?: SettingsSection;
}) {
  const [section, setSection] = useState<SettingsSection>(initialSection ?? "models");
  const [mock, setMock] = useState(snapshot.settings.mock);
  const [providers, setProviders] = useState<ProviderProfile[]>(snapshot.settings.providers);
  const [models, setModels] = useState<ModelProfile[]>(snapshot.settings.models);
  const [defaultModel, setDefaultModel] = useState(snapshot.settings.model);
  const [maxDockGroups, setMaxDockGroups] = useState(
    snapshot.settings.layout?.maxDockGroups ?? DEFAULT_MAX_DOCK_GROUPS,
  );
  const [activeProviderId, setActiveProviderId] = useState(
    snapshot.settings.providers[0]?.id ?? "",
  );
  const [selectedModelId, setSelectedModelId] = useState<string | null>(
    snapshot.settings.models[0]?.id ?? null,
  );
  const [availableByProvider, setAvailableByProvider] = useState<Record<string, string[]>>({});
  const [loadingProvider, setLoadingProvider] = useState<string | null>(null);
  const [providerErrors, setProviderErrors] = useState<Record<string, string>>({});
  const [providerStatus, setProviderStatus] = useState<Record<string, string>>({});
  const [translation, setTranslation] = useState<TranslationSettings | null>(null);
  const [translationBusy, setTranslationBusy] = useState(false);
  const [translationStatus, setTranslationStatus] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<{ kind: "success" | "error"; message: string } | null>(
    null,
  );
  const [gitDirty, setGitDirty] = useState(false);
  const modelBaselineRef = useRef(
    JSON.stringify({
      mock: snapshot.settings.mock,
      providers: snapshot.settings.providers,
      models: snapshot.settings.models,
      model: snapshot.settings.model,
    }),
  );
  const translationBaselineRef = useRef<string | null>(null);
  const layoutBaselineRef = useRef(
    JSON.stringify({ maxDockGroups: normalizeMaxDockGroups(snapshot.settings.layout?.maxDockGroups) }),
  );

  const modelFingerprint = useMemo(
    () =>
      JSON.stringify({
        mock,
        providers,
        models,
        model: defaultModel,
      }),
    [defaultModel, mock, models, providers],
  );
  const translationFingerprint = translation ? JSON.stringify(translation) : null;
  const layoutFingerprint = JSON.stringify({ maxDockGroups });
  const dirty =
    modelFingerprint !== modelBaselineRef.current ||
    layoutFingerprint !== layoutBaselineRef.current ||
    (translationFingerprint !== null &&
      translationBaselineRef.current !== null &&
      translationFingerprint !== translationBaselineRef.current) ||
    gitDirty;

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  useEffect(() => {
    if (!dirty) return;
    if (typeof window.addEventListener !== "function") return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [dirty]);

  useEffect(() => {
    if (dirty) setSaveStatus(null);
  }, [dirty]);

  function changeSection(next: SettingsSection) {
    if (next === section) return;
    if (section === "git" && gitDirty && !window.confirm("Git 设置尚未保存，确定离开吗？")) {
      return;
    }
    if (section === "git") setGitDirty(false);
    setSection(next);
  }

  useEffect(() => {
    if (initialSection) setSection(initialSection);
  }, [initialSection]);

  useEffect(() => {
    let active = true;
    void window.deer
      .getTranslationSettings()
      .then((settings) => {
        if (active) {
          translationBaselineRef.current = JSON.stringify(settings);
          setTranslation(settings);
        }
      })
      .catch(() => {
        if (active) {
          const fallback = { ...DEFAULT_TRANSLATION_SETTINGS };
          translationBaselineRef.current = JSON.stringify(fallback);
          setTranslation(fallback);
        }
      });
    return () => {
      active = false;
    };
  }, []);

  const activeProvider =
    providers.find((provider) => provider.id === activeProviderId) ?? providers[0] ?? null;
  const selectedModel =
    models.find((model) => model.id === selectedModelId) ?? null;

  function providerName(providerId: string): string {
    return providers.find((provider) => provider.id === providerId)?.name ?? providerId;
  }

  async function saveTranslationSettings() {
    if (!translation || translationBusy) return;
    setTranslationBusy(true);
    setTranslationStatus("");
    try {
      const saved = await window.deer.saveTranslationSettings(translation);
      translationBaselineRef.current = JSON.stringify(saved);
      setTranslation(saved);
      setTranslationStatus("已保存，下一条思考生效");
    } catch (error) {
      setTranslationStatus(`保存失败：${formatError(error)}`);
    } finally {
      setTranslationBusy(false);
    }
  }

  function updateProvider(providerId: string, patch: Partial<ProviderProfile>) {
    setProviders((prev) =>
      prev.map((provider) => (provider.id === providerId ? { ...provider, ...patch } : provider)),
    );
  }

  function addProvider() {
    const id = `provider_${Date.now().toString(36)}`;
    const provider = defaultProviderProfile({}, id, `Provider ${providers.length + 1}`);
    setProviders((prev) => [...prev, provider]);
    setActiveProviderId(id);
    setSelectedModelId(null);
  }

  function removeProvider(providerId: string) {
    if (providers.length <= 1) return;
    const nextProviders = providers.filter((provider) => provider.id !== providerId);
    const nextModels = models.filter((model) => model.providerId !== providerId);
    setProviders(nextProviders);
    setModels(nextModels);
    if (!nextModels.some((model) => model.id === defaultModel)) {
      setDefaultModel(nextModels[0]?.id ?? "");
    }
    if (activeProviderId === providerId) {
      setActiveProviderId(nextProviders[0]?.id ?? "");
    }
    if (selectedModelId && !nextModels.some((model) => model.id === selectedModelId)) {
      setSelectedModelId(nextModels[0]?.id ?? null);
    }
    setAvailableByProvider((prev) => {
      const next = { ...prev };
      delete next[providerId];
      return next;
    });
  }

  async function loadProviderModels(provider: ProviderProfile) {
    setLoadingProvider(provider.id);
    setProviderErrors((prev) => ({ ...prev, [provider.id]: "" }));
    setProviderStatus((prev) => ({ ...prev, [provider.id]: "" }));
    try {
      const settings: LlmSettings = {
        baseUrl: providers[0]?.baseUrl ?? "https://api.deepseek.com/v1",
        baseUrlEnv: providers[0]?.baseUrlEnv ?? "",
        apiKey: providers[0]?.apiKey ?? "",
        apiKeyEnv: providers[0]?.apiKeyEnv ?? "",
        providers,
        model: defaultModel,
        models,
        mock,
      };
      const result = await window.deer.listModels(settings, provider.id);
      if (result.error) {
        setAvailableByProvider((prev) => ({ ...prev, [provider.id]: [] }));
        setProviderErrors((prev) => ({
          ...prev,
          [provider.id]: formatError(result.error ?? "获取失败"),
        }));
        return;
      }
      const available = result.models.filter(
        (modelId) =>
          !models.some(
            (model) => model.providerId === provider.id && model.modelId === modelId,
          ),
      );
      setAvailableByProvider((prev) => ({ ...prev, [provider.id]: available }));
      setProviderStatus((prev) => ({
        ...prev,
        [provider.id]: `已获取 ${result.models.length} 个模型；${available.length} 个可添加`,
      }));
    } catch (error) {
      setProviderErrors((prev) => ({
        ...prev,
        [provider.id]: formatError(error),
      }));
    } finally {
      setLoadingProvider(null);
    }
  }

  function addModel(providerId: string, modelId: string) {
    const profile = defaultModelProfile(modelId, providerId);
    if (models.some((model) => model.id === profile.id)) return;
    setModels((prev) => [...prev, profile]);
    setDefaultModel((prev) => prev || profile.id);
    setSelectedModelId(profile.id);
    setActiveProviderId(providerId);
    setAvailableByProvider((prev) => ({
      ...prev,
      [providerId]: (prev[providerId] ?? []).filter((id) => id !== modelId),
    }));
    setProviderStatus((prev) => ({ ...prev, [providerId]: `已添加 ${modelId}` }));
  }

  function removeModel(modelId: string) {
    setModels((prev) => {
      const next = prev.filter((model) => model.id !== modelId);
      if (defaultModel === modelId) setDefaultModel(next[0]?.id ?? "");
      if (selectedModelId === modelId) setSelectedModelId(next[0]?.id ?? null);
      return next;
    });
  }

  function updateModel(modelId: string, patch: Partial<ModelProfile>) {
    setModels((prev) =>
      prev.map((model) => (model.id === modelId ? { ...model, ...patch } : model)),
    );
  }

  function resetModel(model: ModelProfile) {
    const defaults = defaultModelProfile(model.modelId, model.providerId);
    setModels((prev) =>
      prev.map((item) => (item.id === model.id ? defaults : item)),
    );
  }

  async function save() {
    if (saving) return;
    const first = providers[0] ?? defaultProviderProfile();
    const nextMaxDockGroups = normalizeMaxDockGroups(maxDockGroups);
    const payload: LlmSettings = {
      baseUrl: first.baseUrl,
      baseUrlEnv: first.baseUrlEnv,
      apiKey: first.apiKey,
      apiKeyEnv: first.apiKeyEnv,
      providers,
      model: defaultModel || models[0]?.id || "",
      models,
      mock,
      layout: { maxDockGroups: nextMaxDockGroups },
    };
    const fingerprint = JSON.stringify({
      mock: payload.mock,
      providers: payload.providers,
      models: payload.models,
      model: payload.model,
    });
    setSaving(true);
    setSaveStatus(null);
    try {
      const result = await onSave(payload);
      if (result.ok) {
        modelBaselineRef.current = fingerprint;
        setMaxDockGroups(nextMaxDockGroups);
        layoutBaselineRef.current = JSON.stringify({ maxDockGroups: nextMaxDockGroups });
        setSaveStatus({ kind: "success", message: "已保存" });
      } else {
        setSaveStatus({ kind: "error", message: `保存失败：${result.error}` });
      }
    } catch (error) {
      setSaveStatus({ kind: "error", message: `保存失败：${formatError(error)}` });
    } finally {
      setSaving(false);
    }
  }

  // One opportunistic fetch when opening Settings with a configured key.
  useEffect(() => {
    const first = providers[0];
    const info = snapshot.settings.providers.find((provider) => provider.id === first?.id);
    if (!first || !info) return;
    if (info.apiKeySource === "none" && !info.apiKeyEnvSet) return;
    void loadProviderModels(first);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="settings-shell">
      <aside className="settings-subnav">
        <div className="section-label">设置</div>
        <div className={`settings-dirty ${dirty ? "is-dirty" : ""}`} role="status">
          {dirty ? "有未保存修改" : "已同步"}
        </div>
        {SECTIONS.map((item) => (
          <button
            key={item.id}
            className={`settings-nav-item ${section === item.id ? "active" : ""}`}
            onClick={() => changeSection(item.id)}
          >
            <span>{item.label}</span>
            <span className="muted tiny">{item.hint}</span>
          </button>
        ))}
      </aside>

      <div className="settings-main">
        {section === "models" && (
          <>
            <div className="settings-page-head">
              <div>
                <div className="panel-title">模型设置</div>
                <div className="muted tiny">供应商、模型与参数</div>
              </div>
              <button
                type="button"
                className="ghost small"
                onClick={onReload}
                disabled={busy}
              >
                重新检测环境变量
              </button>
            </div>

            <section className="panel settings-block">
              <div className="panel-head">
                <div>
                  <div className="panel-title">供应商</div>
                  <div className="muted tiny">每个供应商独立配置 Base URL 与凭据</div>
                </div>
                <button type="button" className="ghost small" onClick={addProvider} disabled={busy}>
                  + 添加供应商
                </button>
              </div>

              <div className="provider-tabs">
                {providers.map((provider) => (
                  <button
                    key={provider.id}
                    type="button"
                    className={`provider-tab ${activeProvider?.id === provider.id ? "active" : ""}`}
                    onClick={() => setActiveProviderId(provider.id)}
                  >
                    <span>{provider.name}</span>
                    <span className="muted tiny">
                      {models.filter((model) => model.providerId === provider.id).length} 个模型
                    </span>
                  </button>
                ))}
              </div>

              {activeProvider && (
                <div className="provider-editor">
                  <div className="row between">
                    <input
                      className="provider-name"
                      value={activeProvider.name}
                      onChange={(event) =>
                        updateProvider(activeProvider.id, { name: event.target.value })
                      }
                      aria-label="供应商名称"
                    />
                    <button
                      type="button"
                      className="ghost tiny"
                      onClick={() => removeProvider(activeProvider.id)}
                      disabled={providers.length <= 1}
                    >
                      移除供应商
                    </button>
                  </div>

                  <div className="provider-grid">
                    <label>
                      Base URL
                      <input
                        value={activeProvider.baseUrl}
                        onChange={(event) =>
                          updateProvider(activeProvider.id, { baseUrl: event.target.value })
                        }
                      />
                    </label>
                    <label>
                      Base URL 环境变量
                      <input
                        value={activeProvider.baseUrlEnv}
                        onChange={(event) =>
                          updateProvider(activeProvider.id, { baseUrlEnv: event.target.value })
                        }
                        placeholder="DEEPSEEK_BASE_URL"
                      />
                    </label>
                    <label>
                      API Key
                      <input
                        type="password"
                        value={activeProvider.apiKey}
                        onChange={(event) =>
                          updateProvider(activeProvider.id, { apiKey: event.target.value })
                        }
                        placeholder="sk-..."
                      />
                    </label>
                    <label>
                      API Key 环境变量
                      <input
                        value={activeProvider.apiKeyEnv}
                        onChange={(event) =>
                          updateProvider(activeProvider.id, { apiKeyEnv: event.target.value })
                        }
                        placeholder="DEEPSEEK_API_KEY"
                      />
                    </label>
                  </div>

                  <div className="row between wrap">
                    <button
                      type="button"
                      className="ghost small"
                      onClick={() => void loadProviderModels(activeProvider)}
                      disabled={loadingProvider === activeProvider.id || busy}
                    >
                      {loadingProvider === activeProvider.id ? "获取中…" : "获取该供应商模型"}
                    </button>
                    <span className="muted tiny">
                      {snapshot.settings.providers.find(
                        (provider) => provider.id === activeProvider.id,
                      )?.apiKeyEnvActive
                        ? `Key: 环境变量 ${
                            snapshot.settings.providers.find(
                              (provider) => provider.id === activeProvider.id,
                            )?.apiKeyEnvActive
                          }`
                        : "Key: 本地或未配置"}
                    </span>
                  </div>

                  {providerStatus[activeProvider.id] && (
                    <div className="env-status ok">{providerStatus[activeProvider.id]}</div>
                  )}
                  {providerErrors[activeProvider.id] && (
                    <div className="error small">{providerErrors[activeProvider.id]}</div>
                  )}
                  {(availableByProvider[activeProvider.id] ?? []).length > 0 && (
                    <div className="available-models">
                      {(availableByProvider[activeProvider.id] ?? []).map((modelId) => (
                        <button
                          key={modelId}
                          type="button"
                          className="chip"
                          onClick={() => addModel(activeProvider.id, modelId)}
                        >
                          + {modelId}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </section>

            <section className="panel settings-block">
              <div className="panel-head">
                <div>
                  <div className="panel-title">已添加的模型</div>
                  <div className="muted tiny">
                    {models.length} 个模型 · 点击行编辑参数
                  </div>
                </div>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={mock}
                    onChange={(event) => setMock(event.target.checked)}
                  />
                  Mock 模式
                </label>
              </div>

              <div className="model-table-wrap">
                <table className="model-table">
                  <thead>
                    <tr>
                      <th>模型</th>
                      <th>供应商</th>
                      <th>上下文</th>
                      <th>最大输出</th>
                      <th>图片</th>
                      <th>思考</th>
                    </tr>
                  </thead>
                  <tbody>
                    {models.length === 0 && (
                      <tr>
                        <td colSpan={6} className="muted">
                          还没有模型。先在上方获取某个供应商的模型列表。
                        </td>
                      </tr>
                    )}
                    {models.map((model) => (
                      <tr
                        key={model.id}
                        className={selectedModelId === model.id ? "selected" : ""}
                        onClick={() => setSelectedModelId(model.id)}
                      >
                        <td>
                          <span className="mono">{model.modelId}</span>
                          {defaultModel === model.id && <span className="badge">默认</span>}
                        </td>
                        <td>{providerName(model.providerId)}</td>
                        <td>{formatTokens(model.contextWindow)}</td>
                        <td>{formatTokens(model.maxOutputTokens)}</td>
                        <td>{model.supportsImages ? "✓" : "—"}</td>
                        <td>
                          {model.thinkingEnabled ? model.thinkingEffort : "off"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {selectedModel && (
                <div className="model-detail">
                  <div className="row between">
                    <div>
                      <div className="panel-title">{selectedModel.modelId}</div>
                      <div className="muted tiny">{providerName(selectedModel.providerId)}</div>
                    </div>
                    <div className="row gap">
                      <button
                        type="button"
                        className="ghost tiny"
                        onClick={() => resetModel(selectedModel)}
                      >
                        恢复官方默认
                      </button>
                      <button
                        type="button"
                        className="ghost tiny"
                        onClick={() => removeModel(selectedModel.id)}
                      >
                        移除模型
                      </button>
                    </div>
                  </div>
                  <div className="model-grid">
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={selectedModel.supportsImages}
                        onChange={(event) =>
                          updateModel(selectedModel.id, {
                            supportsImages: event.target.checked,
                          })
                        }
                      />
                      读取图片
                    </label>
                    <label>
                      上下文窗口
                      <input
                        type="number"
                        min={1000}
                        step={1000}
                        value={selectedModel.contextWindow}
                        onChange={(event) =>
                          updateModel(selectedModel.id, {
                            contextWindow:
                              Number(event.target.value) || selectedModel.contextWindow,
                          })
                        }
                      />
                    </label>
                    <label>
                      最大输出
                      <input
                        type="number"
                        min={1}
                        max={4000000}
                        step={256}
                        value={selectedModel.maxOutputTokens}
                        onChange={(event) =>
                          updateModel(selectedModel.id, {
                            maxOutputTokens:
                              Number(event.target.value) || selectedModel.maxOutputTokens,
                          })
                        }
                      />
                    </label>
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={selectedModel.thinkingEnabled}
                        onChange={(event) =>
                          updateModel(selectedModel.id, {
                            thinkingEnabled: event.target.checked,
                          })
                        }
                      />
                      深度思考
                    </label>
                    <label>
                      默认思考强度
                      <select
                        value={selectedModel.thinkingEffort}
                        disabled={!selectedModel.thinkingEnabled}
                        onChange={(event) =>
                          updateModel(selectedModel.id, {
                            thinkingEffort: event.target.value as ThinkingEffort,
                          })
                        }
                      >
                        <option value="low">low</option>
                        <option value="medium">medium</option>
                        <option value="high">high</option>
                        <option value="max">max</option>
                      </select>
                    </label>
                  </div>
                </div>
              )}

              <div className="settings-block-foot">
                <label>
                  默认模型
                  <select
                    value={defaultModel}
                    onChange={(event) => setDefaultModel(event.target.value)}
                    disabled={models.length === 0}
                  >
                    {models.map((model) => (
                      <option key={model.id} value={model.id}>
                        {model.label} · {providerName(model.providerId)} ({model.modelId})
                      </option>
                    ))}
                  </select>
                </label>
                <button className="primary" onClick={() => void save()} disabled={busy || saving}>
                  {saving ? "保存中…" : "保存"}
                </button>
                {saveStatus && (
                  <span
                    role={saveStatus.kind === "error" ? "alert" : "status"}
                    className={`settings-save-status is-${saveStatus.kind}`}
                  >
                    {saveStatus.message}
                  </span>
                )}
              </div>
            </section>
          </>
        )}

        {section === "interface" && (
          <section className="panel settings-block">
            <div className="panel-head">
              <div>
                <div className="panel-title">界面设置</div>
                <div className="muted tiny">Dock 分栏上限与工作区布局</div>
              </div>
              <span className="badge">当前 {maxDockGroups} 栏</span>
            </div>
            <div className="settings-block-body">
              <label>
                最大分栏数
                <select
                  aria-label="最大分栏数"
                  value={maxDockGroups}
                  onChange={(event) =>
                    setMaxDockGroups(normalizeMaxDockGroups(event.target.value))
                  }
                >
                  {[2, 3, 4, 5, 6, 7, 8].map((value) => (
                    <option key={value} value={value}>
                      {value} 栏{value === DEFAULT_MAX_DOCK_GROUPS ? "（默认）" : ""}
                    </option>
                  ))}
                </select>
              </label>
              <div className="muted tiny">
                Dock 最多可拆分的分栏数，范围 2–8，默认 {DEFAULT_MAX_DOCK_GROUPS}。
                保存后立即生效，不会重置当前布局；已超过新上限的现有分栏会保留，只拒绝继续拆分。
              </div>
            </div>
            <div className="settings-block-foot">
              <button className="primary" onClick={() => void save()} disabled={busy || saving}>
                {saving ? "保存中…" : "保存界面设置"}
              </button>
              {saveStatus && (
                <span
                  role={saveStatus.kind === "error" ? "alert" : "status"}
                  className={`settings-save-status is-${saveStatus.kind}`}
                >
                  {saveStatus.message}
                </span>
              )}
            </div>
          </section>
        )}

        {section === "translation" && (
          <section className="panel settings-block">
            <div className="panel-head">
              <div>
                <div className="panel-title">翻译设置</div>
                <div className="muted tiny">思考过程自动机翻的来源与模型</div>
              </div>
              <span className="badge">
                {translation?.enabled ? "已启用" : "已关闭"}
              </span>
            </div>
            {!translation ? (
              <div className="settings-block-body muted tiny">正在加载翻译设置…</div>
            ) : (
              <>
                <div className="settings-block-body">
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={translation.enabled}
                      onChange={(event) =>
                        setTranslation({ ...translation, enabled: event.target.checked })
                      }
                    />
                    自动翻译思考过程
                  </label>
                  <label>
                    翻译源
                    <select
                      value={translation.provider}
                      disabled={!translation.enabled}
                      onChange={(event) =>
                        setTranslation({
                          ...translation,
                          provider: event.target.value === "model" ? "model" : "bing",
                        })
                      }
                    >
                      <option value="bing">Bing 在线翻译（默认，无需 key）</option>
                      <option value="model">已配置模型 API（DeepSeek 等）</option>
                    </select>
                  </label>
                  {translation.provider === "model" && (
                    <label>
                      翻译模型
                      <select
                        value={translation.modelProfileId ?? ""}
                        disabled={!translation.enabled || models.length === 0}
                        onChange={(event) =>
                          setTranslation({
                            ...translation,
                            modelProfileId: event.target.value || null,
                          })
                        }
                      >
                        <option value="">
                          默认模型
                          {models.find((model) => model.id === defaultModel)
                            ? `（${models.find((model) => model.id === defaultModel)?.label}）`
                            : ""}
                        </option>
                        {models.map((model) => (
                          <option key={model.id} value={model.id}>
                            {model.label} · {providerName(model.providerId)} ({model.modelId})
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  <div className="muted tiny">
                    目标语言：简体中文。Bing 不需要 API key；模型翻译使用「模型」页里该供应商的
                    API Key，并按已配置模型计费。
                  </div>
                  {translation.provider === "model" && models.length === 0 && (
                    <div className="muted tiny">
                      还没有可用模型，请先到「模型」页添加。
                    </div>
                  )}
                </div>
                <div className="settings-block-foot">
                  <span className="muted tiny">{translationStatus}</span>
                  <button
                    className="primary"
                    onClick={() => void saveTranslationSettings()}
                    disabled={translationBusy}
                  >
                    {translationBusy ? "保存中…" : "保存翻译设置"}
                  </button>
                </div>
              </>
            )}
          </section>
        )}

        {section === "git" && (
          <>
            <div className="settings-page-head">
              <div>
                <div className="panel-title">Git 开发</div>
                <div className="muted tiny">
                  仓库模式、分支/PR、worktree 容量与合并方式
                </div>
              </div>
            </div>
            <div id="settings-git" className="settings-git-tab" tabIndex={-1}>
              <section className="panel settings-block">
                <div className="settings-block-body">
                  <GitSettingsPanel
              workspaceId={snapshot.workspace.id}
              onDirtyChange={setGitDirty}
            />
                </div>
              </section>
            </div>
          </>
        )}

        {section === "team" && (
          <section className="panel settings-block">
            <div className="panel-head">
              <div>
                <div className="panel-title">团队设置</div>
                <div className="muted tiny">默认模型与成员概览</div>
              </div>
            </div>
            <div className="settings-block-body">
              <label>
                默认模型
                <select
                  value={defaultModel}
                  onChange={(event) => setDefaultModel(event.target.value)}
                  disabled={models.length === 0}
                >
                  {models.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.label} · {providerName(model.providerId)} ({model.modelId})
                    </option>
                  ))}
                </select>
              </label>
              <div className="muted tiny">
                成员的提示词、人格与模型在「团队」页点击成员编辑；这里只设置默认模型。
              </div>
              <div className="section-label">成员</div>
              <table className="model-table">
                <thead>
                  <tr>
                    <th>成员</th>
                    <th>角色</th>
                    <th>模型</th>
                    <th>状态</th>
                  </tr>
                </thead>
                <tbody>
                  {snapshot.agents.map((agent) => {
                    const profile = agent.model
                      ? models.find((model) => model.id === agent.model) ??
                        models.find((model) => model.modelId === agent.model)
                      : null;
                    return (
                      <tr key={agent.id}>
                        <td>
                          {agent.name}
                          {agent.isRouter && <span className="badge">Router</span>}
                        </td>
                        <td>{agent.role}</td>
                        <td>
                          {profile
                            ? `${providerName(profile.providerId)} · ${profile.modelId}`
                            : "默认模型"}
                        </td>
                        <td>{agent.status}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="settings-block-foot">
              <button className="primary" onClick={save} disabled={busy}>
                保存
              </button>
            </div>
          </section>
        )}

        {section === "plugins" && (
          <Placeholder
            title="插件"
            description="插件系统用于把工具、命令、界面扩展打包分发。当前后端还没有插件运行时，先保留设置入口。"
            items={["安装/卸载插件包", "启用或禁用单个插件", "查看插件提供的工具与命令", "插件权限与来源"]}
          />
        )}
        {section === "mcp" && (
          <Placeholder
            title="MCP"
            description="MCP 用于接入外部工具服务器。当前 Agent Loop 还没有接入 MCP 客户端，先保留配置入口。"
            items={["添加 stdio / HTTP MCP 服务器", "工具发现与白名单", "按成员限制可用 MCP 工具", "连接状态与日志"]}
          />
        )}
        {section === "skills" && (
          <Placeholder
            title="Skills"
            description="Skills 用于把可复用流程封装成按需加载的能力包。当前还没有扫描与注入 Skill 的后端。"
            items={["扫描工作区 skills/ 目录", "查看 SKILL.md 与附带脚本", "按成员分配技能", "技能版本与来源"]}
          />
        )}
      </div>
    </div>
  );
}

function Placeholder({
  title,
  description,
  items,
}: {
  title: string;
  description: string;
  items: string[];
}) {
  return (
    <section className="panel settings-block">
      <div className="panel-head">
        <div>
          <div className="panel-title">{title}</div>
          <div className="muted tiny">设置入口已就绪，后端能力待接入</div>
        </div>
        <span className="badge">coming next</span>
      </div>
      <div className="settings-placeholder">
        <p>{description}</p>
        <div className="section-label">计划支持</div>
        <ul>
          {items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </div>
    </section>
  );
}
