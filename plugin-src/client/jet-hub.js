/**
 * Jet Hub 设置页（精简版）。
 *
 * 四个分区：OpenCode 免费模型、魔搭社区、自定义供应商、本机网关。
 * 只经 `rpcCall` 与宿主通信，不直接读宿主服务、不注册 provider-card 槽。
 *
 * ⚠️ `notice` 类状态一律用对象形状（或 null），绝不用裸字符串：
 * 历史上渲染期对字符串取属性导致过整页白屏。
 * ⚠️ 明文 API Key 不进组件持久状态；设置页读到的是宿主下发的打码值。
 */

import * as React from 'react';
import { PROVIDER_REGISTRY } from '../../src/provider-registry.js';

export const JET_HUB_RPC_CHANNEL = '/jet-hub';

/** 渠道 id → 展示名，查不到时原样返回 id。 */
export function providerLabel(id) {
  return PROVIDER_REGISTRY.find((entry) => entry.id === id)?.label ?? id;
}

const API_OPTIONS = [
  { value: 'openai-completions', label: 'OpenAI Chat Completions（默认）' },
  { value: 'openai-responses', label: 'OpenAI Responses' },
  { value: 'anthropic-messages', label: 'Anthropic Messages' },
];

const TABS = [
  { id: 'opencode', label: 'OpenCode 免费模型' },
  { id: 'modelscope', label: '魔搭社区' },
  { id: 'custom', label: '自定义供应商' },
  { id: 'gateway', label: '本机网关' },
];

const cardStyle = {
  border: '1px solid var(--border, #d9dde3)',
  borderRadius: 8,
  padding: 16,
  marginBottom: 12,
  background: 'var(--surface, #fff)',
};
const rowStyle = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' };
const inputStyle = { flex: '1 1 220px', minWidth: 160, padding: '6px 8px' };

function Section({ title, hint, children }) {
  return React.createElement('section', { style: cardStyle },
    React.createElement('h3', { style: { margin: '0 0 6px', fontSize: 15 } }, title),
    hint ? React.createElement('p', { style: { margin: '0 0 12px', opacity: 0.7, fontSize: 12 } }, hint) : null,
    children,
  );
}

function Notice({ notice }) {
  if (!notice || typeof notice !== 'object') return null;
  return React.createElement('div', {
    style: { padding: '8px 10px', marginBottom: 12, borderRadius: 6, background: notice.ok ? 'rgba(40,160,90,.12)' : 'rgba(200,50,50,.12)' },
  }, notice.text);
}

function Button({ children, onClick, disabled }) {
  return React.createElement('button', {
    type: 'button',
    onClick,
    disabled: disabled === true,
    style: { padding: '6px 12px', cursor: disabled === true ? 'not-allowed' : 'pointer', opacity: disabled === true ? 0.55 : 1 },
  }, children);
}

/** OpenCode 免费模型：只列免费档，逐模型启停，可强制刷新目录。 */
function OpencodeSection({ rpcCall, notify }) {
  const [rows, setRows] = React.useState([]);
  const [meta, setMeta] = React.useState({});
  const [busy, setBusy] = React.useState(false);

  const load = React.useCallback(async (force) => {
    setBusy(true);
    try {
      const result = force
        ? await rpcCall('opencode.sync', {})
        : await rpcCall('opencode.catalog', {});
      if (!force) {
        setRows(Array.isArray(result?.rows) ? result.rows : []);
        setMeta({
          syncedAt: result?.syncedAt,
          reason: result?.reason,
          error: result?.error,
          includeDeprecated: result?.includeDeprecated === true,
        });
      } else {
        const fresh = await rpcCall('opencode.catalog', {});
        setRows(Array.isArray(fresh?.rows) ? fresh.rows : []);
        setMeta({ syncedAt: fresh?.syncedAt, reason: fresh?.reason, error: fresh?.error, includeDeprecated: fresh?.includeDeprecated === true });
        notify({ ok: true, text: '目录已同步' });
      }
    } catch (error) {
      notify({ ok: false, text: `目录读取失败：${error?.message ?? String(error)}` });
    } finally {
      setBusy(false);
    }
  }, [rpcCall, notify]);

  React.useEffect(() => { void load(false); }, [load]);

  const toggle = async (id, currentlyDisabled) => {
    const next = currentlyDisabled
      ? rows.filter((row) => row.disabled && row.id !== id).map((row) => row.id)
      : [...rows.filter((row) => row.disabled).map((row) => row.id), id];
    try {
      const result = await rpcCall('opencode.setDisabled', { disabledModels: next });
      const disabled = new Set(result?.disabledModels ?? next);
      setRows((prev) => prev.map((row) => ({ ...row, disabled: disabled.has(row.id) })));
    } catch (error) {
      notify({ ok: false, text: `模型启停失败：${error?.message ?? String(error)}` });
    }
  };

  const setIncludeDeprecated = async (enabled) => {
    try {
      await rpcCall('opencode.setIncludeDeprecated', { enabled });
      await load(false);
    } catch (error) {
      notify({ ok: false, text: `开关写入失败：${error?.message ?? String(error)}` });
    }
  };

  return React.createElement(Section, {
    title: 'OpenCode 免费模型',
    hint: '出网只经本机 OpenCode 官方客户端桥；插件不配 Key、不构造推理请求。列表默认只含免费档，下架与弃用模型需显式开关才显示。',
  },
    React.createElement('div', { style: rowStyle },
      React.createElement(Button, { onClick: () => void load(true), disabled: busy }, busy ? '同步中…' : '立即同步'),
      React.createElement('label', { style: { ...rowStyle, fontSize: 12 } },
        React.createElement('input', {
          type: 'checkbox',
          checked: meta.includeDeprecated === true,
          onChange: (event) => void setIncludeDeprecated(event.target.checked),
        }),
        '显示弃用 / 已下架模型',
      ),
      meta.syncedAt
        ? React.createElement('span', { style: { fontSize: 12, opacity: 0.65 } }, `上次同步：${new Date(meta.syncedAt).toLocaleString()}（${meta.reason ?? '未知'}）`)
        : null,
    ),
    meta.error ? React.createElement('p', { style: { fontSize: 12, color: '#b4433a' } }, `目录降级：${meta.error}`) : null,
    rows.length === 0
      ? React.createElement('p', { style: { fontSize: 13, opacity: 0.7 } }, busy ? '正在读取目录…' : '暂无可用免费模型。请确认本机已安装 OpenCode 2.x 客户端后点「立即同步」。')
      : React.createElement('div', { style: { display: 'grid', gap: 6 } },
          rows.map((row) => React.createElement('label', {
            key: row.id,
            style: { ...rowStyle, fontSize: 13, opacity: row.unavailable ? 0.55 : 1 },
          },
            React.createElement('input', {
              type: 'checkbox',
              checked: !row.disabled,
              disabled: row.unavailable === true,
              onChange: () => void toggle(row.id, row.disabled === true),
            }),
            React.createElement('span', { style: { minWidth: 190 } }, row.name || row.id),
            React.createElement('code', { style: { fontSize: 11, opacity: 0.7 } }, row.id),
            row.reason ? React.createElement('span', { style: { fontSize: 11, opacity: 0.7 } }, row.reason) : null,
          ))),
  );
}

/** 魔搭社区：静态 API Key，保存后即时生效。 */
function ModelscopeSection({ rpcCall, notify }) {
  const [status, setStatus] = React.useState({ configured: false });
  const [draftKey, setDraftKey] = React.useState('');

  React.useEffect(() => {
    let alive = true;
    void rpcCall('modelscope.status', {}).then((value) => {
      if (alive && value && typeof value === 'object') setStatus(value);
    }).catch(() => {});
    return () => { alive = false; };
  }, [rpcCall]);

  const save = async () => {
    try {
      const result = await rpcCall('modelscope.setApiKey', { apiKey: draftKey });
      setStatus({ configured: result?.configured === true });
      setDraftKey('');
      notify({ ok: true, text: '魔搭 API Key 已保存' });
    } catch (error) {
      notify({ ok: false, text: `保存失败：${error?.message ?? String(error)}` });
    }
  };

  return React.createElement(Section, {
    title: '魔搭社区（官方接入）',
    hint: '标准 OpenAI 兼容接口，需用户在魔搭控制台生成 API Key。密钥只存于插件自有状态文档，设置页仅显示打码值。',
  },
    React.createElement('p', { style: { fontSize: 13 } },
      status.configured ? '状态：已配置' : '状态：未配置（模型仍会显示，但请求会返回认证失败）',
      status.keyMasked ? ` · ${status.keyMasked}` : '',
    ),
    React.createElement('div', { style: rowStyle },
      React.createElement('input', {
        type: 'password',
        style: inputStyle,
        placeholder: '输入新的 API Key（留空并保存可清除）',
        value: draftKey,
        onChange: (event) => setDraftKey(event.target.value),
      }),
      React.createElement(Button, { onClick: () => void save() }, '保存'),
    ),
  );
}

const EMPTY_DRAFT = {
  id: '', displayName: '', api: 'openai-completions', baseURL: '',
  apiKey: '', models: '', enabled: true,
};

/** 自定义供应商：多实例增删改、连通性测试、自动拉取模型目录。 */
function CustomSection({ rpcCall, notify }) {
  const [providers, setProviders] = React.useState([]);
  const [draft, setDraft] = React.useState({ ...EMPTY_DRAFT });
  const [editing, setEditing] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  const reload = React.useCallback(async () => {
    try {
      const result = await rpcCall('custom.list', {});
      setProviders(Array.isArray(result?.providers) ? result.providers : []);
    } catch (error) {
      notify({ ok: false, text: `自定义供应商列表读取失败：${error?.message ?? String(error)}` });
    }
  }, [rpcCall, notify]);

  React.useEffect(() => { void reload(); }, [reload]);

  const configFromDraft = () => ({
    id: draft.id.trim(),
    displayName: draft.displayName.trim(),
    api: draft.api,
    baseURL: draft.baseURL.trim(),
    apiKey: draft.apiKey,
    enabled: draft.enabled !== false,
    models: String(draft.models || '').split(/[\n,]/).map((id) => id.trim()).filter(Boolean).map((id) => ({ id, name: id, contextWindow: 0 })),
  });

  const persist = async () => {
    setBusy(true);
    try {
      const result = await rpcCall('custom.upsert', { config: configFromDraft() });
      setProviders(Array.isArray(result?.providers) ? result.providers : []);
      setDraft({ ...EMPTY_DRAFT });
      setEditing(false);
      notify({ ok: true, text: '自定义供应商已保存并注册路由' });
    } catch (error) {
      notify({ ok: false, text: `保存失败：${error?.message ?? String(error)}` });
    } finally {
      setBusy(false);
    }
  };

  const probe = async (method, successText) => {
    setBusy(true);
    try {
      const result = await rpcCall(method, { config: configFromDraft() });
      if (method === 'custom.fetchModels' && result?.ok !== false && Array.isArray(result?.models)) {
        setDraft((prev) => ({ ...prev, models: result.models.map((m) => m.id).join('\n') }));
      }
      notify({ ok: result?.ok !== false, text: `${successText}：${result?.message ?? result?.error ?? (result?.models ? `读到 ${result.models.length} 个模型` : '完成')}` });
    } catch (error) {
      notify({ ok: false, text: `${successText}失败：${error?.message ?? String(error)}` });
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id) => {
    try {
      const result = await rpcCall('custom.remove', { id });
      setProviders(Array.isArray(result?.providers) ? result.providers : []);
      notify({ ok: true, text: `已删除 ${id}` });
    } catch (error) {
      notify({ ok: false, text: `删除失败：${error?.message ?? String(error)}` });
    }
  };

  const field = (key, label, props) => React.createElement('label', { key, style: { display: 'grid', gap: 4, flex: '1 1 220px', fontSize: 12 } },
    label,
    React.createElement('input', { style: { ...inputStyle, width: '100%' }, value: draft[key] ?? '', onChange: (event) => setDraft((prev) => ({ ...prev, [key]: event.target.value })), ...props }),
  );

  return React.createElement(Section, {
    title: '自定义供应商',
    hint: '每个实例注册一条独立路由，默认 OpenAI Chat Completions；另支持 OpenAI Responses 与 Anthropic Messages。接口类型决定请求体与 SSE 解帧方式。',
  },
    providers.length === 0
      ? React.createElement('p', { style: { fontSize: 13, opacity: 0.7 } }, '尚未添加自定义供应商。')
      : React.createElement('div', { style: { display: 'grid', gap: 6, marginBottom: 12 } },
          providers.map((item) => React.createElement('div', { key: item.id, style: rowStyle },
            React.createElement('strong', { style: { minWidth: 130 } }, item.displayName || item.id),
            React.createElement('code', { style: { fontSize: 11 } }, item.id),
            React.createElement('span', { style: { fontSize: 12, opacity: 0.7 } }, item.api),
            React.createElement('span', { style: { fontSize: 11, opacity: 0.7 } }, item.baseURL),
            React.createElement('span', { style: { fontSize: 11, opacity: 0.7 } }, `${item.modelCount ?? 0} 个模型`),
            item.enabled === false ? React.createElement('span', { style: { fontSize: 11 } }, '已停用') : null,
            React.createElement(Button, { onClick: () => {
              setEditing(true);
              setDraft({
                id: item.id, displayName: item.displayName || '', api: item.api || 'openai-completions',
                baseURL: item.baseURL || '', apiKey: '',
                models: (item.models || []).map((model) => model.id).join('\n'),
                enabled: item.enabled !== false,
              });
            } }, '编辑'),
            React.createElement(Button, { onClick: () => void remove(item.id) }, '删除'),
          ))),
    React.createElement('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8 } },
      field('id', '路由 id（小写字母/数字，如 myapi）', { placeholder: 'myapi', disabled: editing }),
      field('displayName', '展示名', { placeholder: '我的供应商' }),
      field('baseURL', 'baseURL', { placeholder: 'https://example.com/v1' }),
      field('apiKey', editing ? 'API Key（留空保留原值）' : 'API Key', { type: 'password', placeholder: 'sk-…' }),
    ),
    React.createElement('label', { style: { display: 'grid', gap: 4, marginTop: 8, fontSize: 12 } },
      '接口类型',
      React.createElement('select', {
        value: draft.api,
        style: { padding: '6px 8px', maxWidth: 340 },
        onChange: (event) => setDraft((prev) => ({ ...prev, api: event.target.value })),
      }, API_OPTIONS.map((option) => React.createElement('option', { key: option.value, value: option.value }, option.label))),
    ),
    React.createElement('label', { style: { display: 'grid', gap: 4, marginTop: 8, fontSize: 12 } },
      '模型 id（每行一个，或用「自动拉取模型」填入）',
      React.createElement('textarea', {
        rows: 3,
        style: { padding: '6px 8px', width: '100%' },
        value: draft.models,
        placeholder: 'model-a\nmodel-b',
        onChange: (event) => setDraft((prev) => ({ ...prev, models: event.target.value })),
      }),
    ),
    React.createElement('div', { style: { ...rowStyle, marginTop: 10 } },
      React.createElement(Button, { onClick: () => void persist(), disabled: busy }, '保存并注册'),
      React.createElement(Button, { onClick: () => void probe('custom.test', '连通性测试'), disabled: busy }, '测试连通'),
      React.createElement(Button, { onClick: () => void probe('custom.fetchModels', '模型拉取'), disabled: busy }, '自动拉取模型'),
      editing ? React.createElement(Button, { onClick: () => { setDraft({ ...EMPTY_DRAFT }); setEditing(false); } }, '取消编辑') : null,
    ),
  );
}

/** 本机 OpenAI 兼容网关：只读状态 + 启停。 */
function GatewaySection({ rpcCall, notify }) {
  const [status, setStatus] = React.useState(null);
  const reload = React.useCallback(async () => {
    try {
      const value = await rpcCall('gateway.status', {});
      setStatus(value && typeof value === 'object' ? value : null);
    } catch (error) {
      notify({ ok: false, text: `网关状态读取失败：${error?.message ?? String(error)}` });
    }
  }, [rpcCall, notify]);
  React.useEffect(() => { void reload(); }, [reload]);

  const flip = async (enabled) => {
    try {
      await rpcCall('gateway.setEnabled', { enabled });
      await reload();
      notify({ ok: true, text: enabled ? '网关已启用' : '网关已停用' });
    } catch (error) {
      notify({ ok: false, text: `网关开关失败：${error?.message ?? String(error)}` });
    }
  };

  return React.createElement(Section, {
    title: '本机 OpenAI 兼容网关',
    hint: '按已注册路由动态枚举模型，无需维护渠道清单；监听地址与端口由环境变量控制。',
  },
    React.createElement('p', { style: { fontSize: 13 } },
      status === null ? '正在读取状态…' : `状态：${status.running ? '运行中' : '未运行'} · 期望：${status.desired ? '启用' : '停用'}`,
      status?.address ? ` · ${status.address.host}:${status.address.port}` : '',
    ),
    status?.apiKeyMasked ? React.createElement('p', { style: { fontSize: 12, opacity: 0.7 } }, `访问密钥：${status.apiKeyMasked}`) : null,
    React.createElement(Button, { onClick: () => void flip(status?.desired !== true) }, status?.desired ? '停用网关' : '启用网关'),
  );
}

export function JetHubPage({ rpcCall }) {
  const [tab, setTab] = React.useState('opencode');
  const [notice, setNotice] = React.useState(null);
  const notify = React.useCallback((value) => {
    setNotice(value && typeof value === 'object' ? value : { ok: false, text: String(value) });
  }, []);

  return React.createElement('div', { style: { padding: 16, maxWidth: 980 } },
    React.createElement('h2', { style: { margin: '0 0 4px', fontSize: 18 } }, 'Jet Hub'),
    React.createElement('p', { style: { margin: '0 0 16px', fontSize: 12, opacity: 0.7 } },
      'OpenCode 免费档桥 · 魔搭官方接入 · 自定义供应商'),
    React.createElement('div', { style: { ...rowStyle, marginBottom: 16, borderBottom: '1px solid var(--border, #d9dde3)' } },
      TABS.map((item) => React.createElement(Button, {
        key: item.id,
        onClick: () => { setTab(item.id); setNotice(null); },
      }, tab === item.id ? `● ${item.label}` : item.label)),
    ),
    React.createElement(Notice, { notice }),
    tab === 'opencode' ? React.createElement(OpencodeSection, { rpcCall, notify }) : null,
    tab === 'modelscope' ? React.createElement(ModelscopeSection, { rpcCall, notify }) : null,
    tab === 'custom' ? React.createElement(CustomSection, { rpcCall, notify }) : null,
    tab === 'gateway' ? React.createElement(GatewaySection, { rpcCall, notify }) : null,
  );
}
