/**
 * Jet Hub 设置页（0.3.2 单分区版）。
 *
 * 仅保留 OpenCode 免费档桥一个分区，通过 rpcCall 与宿主通信，
 * 不直接读取宿主服务，不注册 provider-card 槽。
 *
 * notice 状态统一采用对象形状或 null，避免渲染期对字符串取属性导致异常。
 * 明文密钥不进入组件持久状态，设置页读取宿主下发的打码值。
 */

import * as React from 'react';

export const JET_HUB_RPC_CHANNEL = '/jet-hub';

const PROVIDER_LABELS = { opencode: 'OpenCode' };

/** 渠道 id 到展示名的本地映射，查不到时原样返回 id。 */
export function providerLabel(id) {
  return PROVIDER_LABELS[id] ?? id;
}

const cardStyle = {
  border: '1px solid var(--border, #d9dde3)',
  borderRadius: 8,
  padding: 16,
  marginBottom: 12,
  background: 'var(--surface, #fff)',
};
const rowStyle = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' };
/** 公共输入控件样式，供需要文本录入的控件复用。 */
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

/** 两级连通性测试：传入 model 时按单模型测试，否则按供应商整体测试；忙碌状态由组件自身维护。 */
function ProbeButton({ provider, model, label, rpcCall, notify, disabled }) {
  const [busy, setBusy] = React.useState(false);
  const isDisabled = busy || disabled === true;

  const run = async () => {
    if (isDisabled) return;
    setBusy(true);
    try {
      const result = model
        ? await rpcCall('probe.model', { provider, model })
        : await rpcCall('probe.provider', { provider });
      notify({ ok: result?.ok === true, text: `${label}：${result?.message ?? '无返回'}（${result?.elapsedMs ?? 0} ms）` });
    } catch (error) {
      notify({ ok: false, text: `${label}失败：${error?.message ?? String(error)}` });
    } finally {
      setBusy(false);
    }
  };

  return React.createElement(Button, {
    onClick: () => void run(),
    disabled: isDisabled,
  }, busy ? '测试中…' : label);
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
    hint: '插件只承接 OpenCode 免费档，出网仅经本机官方客户端桥；连通性测试会发送一次最小请求，可能消耗免费档额度。列表默认只含免费档，弃用或已下架模型需显式开启开关后才会显示。',
  },
    React.createElement('div', { style: rowStyle },
      React.createElement(Button, { onClick: () => void load(true), disabled: busy }, busy ? '同步中…' : '立即同步'),
      React.createElement(ProbeButton, { provider: 'opencode', label: '测试供应商', rpcCall, notify }),
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
            React.createElement(ProbeButton, { provider: 'opencode', model: row.id, label: '单模型测试', rpcCall, notify }),
          ))),
  );
}

export function JetHubPage({ rpcCall }) {
  const [notice, setNotice] = React.useState(null);
  const notify = React.useCallback((value) => {
    setNotice(value && typeof value === 'object' ? value : { ok: false, text: String(value) });
  }, []);

  return React.createElement('div', { style: { padding: 16, maxWidth: 980 } },
    React.createElement('h2', { style: { margin: '0 0 4px', fontSize: 18 } }, 'Jet Hub'),
    React.createElement('p', { style: { margin: '0 0 16px', fontSize: 12, opacity: 0.7 } }, 'OpenCode 免费档桥'),
    React.createElement(Notice, { notice }),
    React.createElement(OpencodeSection, { rpcCall, notify }),
  );
}
