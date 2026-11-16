/**
 * Browser half of @local/dynamic-memory.
 *
 * A minimal operator panel for the memory store. It renders above the composer
 * (`conversation.input.dock`) and performs every read/action through the Host's
 * existing `/dmem` session command, so the panel never re-implements memory
 * logic. Rendering, data, and validation therefore share one entry point.
 *
 * This file is the shipped client bundle: the Host's client-modules row serves
 * it from exports["./client"] of package.json. It is plain JavaScript on
 * purpose; no build step is required.
 */
window.__ModuleLoader__.load({
  id: '@local/dynamic-memory',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'dynamic-memory';
    const SLOT = 'conversation.input.dock';
    const ENTRY_ID = 'dynamic-memory';
    /** Every action routes through this one Host command surface. */
    const COMMAND = '/dmem';

    const zh = {
      title: '记忆面板',
      'hint.closed': '状态 · 搜索 · 画像',
      'hint.open': '点击收起',
      'open.title': '打开记忆面板',
      'close.title': '收起记忆面板',
      'tab.status': '状态',
      'tab.search': '搜索',
      'tab.portrait': '画像',
      'status.refresh': '刷新状态',
      'status.loading': '读取中…',
      'status.empty': '尚未读取；点击「刷新状态」运行 /dmem stats。',
      'search.placeholder': '关键词，回车搜索',
      'search.action': '搜索',
      'search.empty': '输入关键词搜索记忆。',
      'portrait.user': '用户画像',
      'portrait.assistant': '助手画像',
      'portrait.empty': '选择要查看的画像。',
      'capture.title': '自动捕获',
      'capture.pause': '暂停',
      'capture.resume': '恢复',
      'consent.title': '同意开关（C1–C4）',
      'consent.memory': 'C1 记忆',
      'consent.inject': 'C2 注入',
      'consent.profile': 'C3 画像',
      'consent.sensitive': 'C4 敏感',
      on: '开',
      off: '关',
      'profile.unified': '统一',
      'profile.situational': '情境',
      'export.action': '导出记忆',
      'clear.title': '清除/迁移',
      'clear.hint': '面板不执行破坏性操作。请先导出，再手动运行：',
      busy: '执行中…',
      'error.remote': '调用 Host 失败',
      'error.unknownCommand': '/dmem 命令不可用：dynamic-memory 的命令服务未加载。',
      'error.session': '当前会话不可用。',
      'result.done': '已完成',
      'note.commandLog': '这些按钮等价于手动执行 /dmem 命令，会在本会话写入命令记录。',
    };
    const en = {
      title: 'Memory',
      'hint.closed': 'status · search · portrait',
      'hint.open': 'click to collapse',
      'open.title': 'Open the memory panel',
      'close.title': 'Collapse the memory panel',
      'tab.status': 'Status',
      'tab.search': 'Search',
      'tab.portrait': 'Portrait',
      'status.refresh': 'Refresh status',
      'status.loading': 'Loading…',
      'status.empty': 'Not loaded yet; refresh to run /dmem stats.',
      'search.placeholder': 'keywords, then Enter',
      'search.action': 'Search',
      'search.empty': 'Type keywords to search memory.',
      'portrait.user': 'User portrait',
      'portrait.assistant': 'Assistant portrait',
      'portrait.empty': 'Choose a portrait to view.',
      'capture.title': 'Auto capture',
      'capture.pause': 'Pause',
      'capture.resume': 'Resume',
      'consent.title': 'Consent (C1–C4)',
      'consent.memory': 'C1 memory',
      'consent.inject': 'C2 injection',
      'consent.profile': 'C3 portrait',
      'consent.sensitive': 'C4 sensitive',
      on: 'On',
      off: 'Off',
      'profile.unified': 'Unified',
      'profile.situational': 'Situational',
      'export.action': 'Export memory',
      'clear.title': 'Clear/migrate',
      'clear.hint': 'The panel runs no destructive action. Export first, then run manually:',
      busy: 'Working…',
      'error.remote': 'Host call failed',
      'error.unknownCommand': '/dmem is unavailable: the dynamic-memory command service is not loaded.',
      'error.session': 'The current session is unavailable.',
      'result.done': 'Done',
      'note.commandLog': 'These buttons are equivalent to running /dmem yourself; each writes command records to this session.',
    };

    /** Theme-token palette; every color is inherited from the Host theme. */
    const palette = {
      surface: 'var(--dsw-alias-bg-layer-1, var(--dsw-alias-bg-base, transparent))',
      border: 'var(--dsw-alias-border-l1, rgba(127,127,127,0.28))',
      text: 'var(--dsw-alias-label-primary, inherit)',
      muted: 'var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary, inherit))',
      hover: 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.12))',
      chip: 'var(--dsw-alias-bg-module-platform, rgba(127,127,127,0.10))',
      danger: 'var(--dsw-alias-state-error-primary, #d03050)',
      radius: 'var(--dsw-radius-lg, 12px)',
      radiusSm: 'var(--dsw-radius-md, 8px)',
    };

    const styles = {
      root: {
        boxSizing: 'border-box',
        width: 'calc(100% - 16px)',
        maxWidth: '760px',
        margin: '0 auto 8px',
        border: `0.5px solid ${palette.border}`,
        borderRadius: palette.radius,
        background: palette.surface,
        color: palette.text,
        overflow: 'hidden',
        font: 'inherit',
      },
      header: {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        width: '100%',
        padding: '4px 12px',
        border: 'none',
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        fontSize: '13px',
        lineHeight: '22px',
        textAlign: 'left',
        cursor: 'pointer',
      },
      title: { flex: 'none', fontWeight: 500, color: palette.text },
      hint: {
        flex: 'auto',
        minWidth: 0,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        color: palette.muted,
        fontSize: '12px',
      },
      chevron: { flex: 'none', color: palette.muted, fontSize: '11px' },
      body: {
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
        padding: '0 12px 10px',
      },
      tabRow: { display: 'flex', gap: '4px', flexWrap: 'wrap' },
      tab: {
        border: 'none',
        borderRadius: palette.radiusSm,
        background: 'transparent',
        color: palette.muted,
        font: 'inherit',
        fontSize: '12px',
        lineHeight: '22px',
        padding: '2px 10px',
        cursor: 'pointer',
      },
      tabActive: {
        background: palette.chip,
        color: palette.text,
      },
      row: { display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' },
      sectionLabel: { fontSize: '12px', color: palette.muted, flex: 'none' },
      button: {
        border: `0.5px solid ${palette.border}`,
        borderRadius: palette.radiusSm,
        background: 'transparent',
        color: palette.text,
        font: 'inherit',
        fontSize: '12px',
        lineHeight: '22px',
        padding: '1px 9px',
        cursor: 'pointer',
      },
      input: {
        flex: 'auto',
        minWidth: 0,
        border: `0.5px solid ${palette.border}`,
        borderRadius: palette.radiusSm,
        background: 'transparent',
        color: palette.text,
        font: 'inherit',
        fontSize: '12px',
        lineHeight: '22px',
        padding: '1px 8px',
        outline: 'none',
      },
      output: {
        margin: 0,
        maxHeight: '220px',
        overflow: 'auto',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        fontSize: '12px',
        lineHeight: '18px',
        color: palette.text,
        borderRadius: palette.radiusSm,
        background: palette.chip,
        padding: '8px 10px',
      },
      outputError: { color: palette.danger },
      controls: {
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
        borderTop: `0.5px solid ${palette.border}`,
        paddingTop: '8px',
      },
      clear: {
        display: 'flex',
        gap: '6px',
        alignItems: 'baseline',
        flexWrap: 'wrap',
        fontSize: '12px',
        color: palette.muted,
      },
      code: {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        fontSize: '11px',
        background: palette.chip,
        borderRadius: '4px',
        padding: '0 4px',
        color: palette.text,
      },
      note: { fontSize: '11px', lineHeight: '16px', color: palette.muted },
      glyph: { flex: 'none', display: 'grid', placeItems: 'center', width: '16px', height: '16px' },
    };

    const disabledStyle = { opacity: 0.55, cursor: 'default' };

    /** Map one Host Remote outcome to display text. */
    function describeResult(result, t) {
      if (!result || result.ok !== true) {
        const error = result && result.error ? result.error : undefined;
        const detail = error ? `${error.code ? error.code + ': ' : ''}${error.message || ''}` : '';
        return { failed: true, text: t('error.remote') + (detail ? ` (${detail})` : '') };
      }
      if (result.value === undefined) return { failed: true, text: t('error.unknownCommand') };
      const settled = result.value && result.value.result ? result.value.result : undefined;
      const kind = settled && settled.kind;
      const text = settled && typeof settled.text === 'string' && settled.text.trim() !== '' ? settled.text : '';
      return { failed: kind === 'error', text: text || (kind === 'error' ? t('error.remote') : t('result.done')) };
    }

    /** A small memory glyph drawn from the plugin's own icon artwork. */
    function MemoryGlyph() {
      return h(
        'svg',
        { viewBox: '0 0 64 64', width: 15, height: 15, 'aria-hidden': true, style: { display: 'block' } },
        h('path', {
          d: 'M32 14c-4 0-7 3-7 7v3a9 9 0 0 0-6 8v3a9 9 0 0 0 6 8v2a7 7 0 0 0 14 0v-2a9 9 0 0 0 6-8v-3a9 9 0 0 0-6-8v-3c0-4-3-7-7-7Z',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
        h('path', {
          d: 'M25 29h-5m19 0h5M25 40h-4m18 0h4M32 22v22',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 4,
          strokeLinecap: 'round',
          opacity: 0.7,
        }),
      );
    }

    /** One panel button; shared by tabs, actions, and consent switches. */
    function Button({ label, onClick, disabled, active, title }) {
      const style = active ? { ...styles.button, ...styles.tabActive } : styles.button;
      return h(
        'button',
        {
          type: 'button',
          title: title || label,
          'aria-pressed': active === undefined ? undefined : active,
          onClick,
          disabled,
          style: disabled ? { ...style, ...disabledStyle } : style,
        },
        label,
      );
    }

    /**
     * Dock component. `exec` and `t` arrive from the slot registration's
     * `inject`; `sessionId` is the standard session-scope slot prop.
     */
    function MemoryPanel({ sessionId, exec, t }) {
      const [open, setOpen] = React.useState(false);
      const [tab, setTab] = React.useState('status');
      const [busy, setBusy] = React.useState(false);
      const [output, setOutput] = React.useState('');
      const [failed, setFailed] = React.useState(false);
      const [lastLine, setLastLine] = React.useState('');
      const [query, setQuery] = React.useState('');
      const loadedOnce = React.useRef(false);

      // A different session owns different memory output; never show the previous one.
      React.useEffect(() => {
        setOutput('');
        setFailed(false);
        setLastLine('');
        setBusy(false);
        setTab('status');
        setQuery('');
        loadedOnce.current = false;
      }, [sessionId]);

      const run = React.useCallback(
        async (line) => {
          if (!exec) {
            setOutput(t('error.session'));
            setFailed(true);
            return;
          }
          setBusy(true);
          setLastLine(line);
          try {
            const described = describeResult(await exec(line), t);
            setOutput(described.text);
            setFailed(described.failed);
          } catch (error) {
            const message = error && error.message ? error.message : String(error);
            setOutput(`${t('error.remote')} (${message})`);
            setFailed(true);
          } finally {
            setBusy(false);
          }
        },
        [exec, t],
      );

      const toggle = () => {
        const next = !open;
        setOpen(next);
        if (next && !loadedOnce.current && tab === 'status') {
          loadedOnce.current = true;
          void run(`${COMMAND} stats`);
        }
      };

      const selectTab = (next) => {
        setTab(next);
        if (next === 'status' && !loadedOnce.current) {
          loadedOnce.current = true;
          void run(`${COMMAND} stats`);
        }
      };

      const submitSearch = () => {
        const value = query.trim();
        if (!value) {
          setOutput(t('search.empty'));
          setFailed(false);
          return;
        }
        void run(`${COMMAND} search ${value}`);
      };

      const header = h(
        'button',
        {
          type: 'button',
          onClick: toggle,
          'aria-expanded': open,
          title: t(open ? 'close.title' : 'open.title'),
          style: styles.header,
        },
        h('span', { style: styles.glyph }, h(MemoryGlyph, null)),
        h('span', { style: styles.title }, t('title')),
        h('span', { style: styles.hint }, t(open ? 'hint.open' : 'hint.closed')),
        h('span', { style: styles.chevron, 'aria-hidden': true }, open ? '▾' : '▸'),
      );

      if (!open) return h('div', { style: styles.root, 'data-dynamic-memory-panel': 'closed' }, header);

      const busyLabel = busy ? t('busy') : '';
      const outputBox = (emptyText) =>
        h(
          'pre',
          {
            style: failed ? { ...styles.output, ...styles.outputError } : styles.output,
            'data-dynamic-memory-output': lastLine || '',
          },
          output || emptyText,
        );

      const tabs = h(
        'div',
        { style: styles.tabRow, role: 'tablist' },
        ['status', 'search', 'portrait'].map((value) =>
          h(Button, {
            key: value,
            label: t(`tab.${value}`),
            active: tab === value,
            onClick: () => selectTab(value),
          }),
        ),
        h('span', { style: { ...styles.sectionLabel, marginLeft: 'auto' } }, busyLabel),
      );

      let tabBody;
      if (tab === 'search') {
        tabBody = h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
          h(
            'div',
            { style: styles.row },
            h('input', {
              type: 'text',
              value: query,
              placeholder: t('search.placeholder'),
              'aria-label': t('search.placeholder'),
              style: styles.input,
              onChange: (event) => setQuery(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  submitSearch();
                }
              },
            }),
            h(Button, { label: t('search.action'), onClick: submitSearch, disabled: busy || query.trim() === '' }),
          ),
          outputBox(t('search.empty')),
        );
      } else if (tab === 'portrait') {
        tabBody = h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
          h(
            'div',
            { style: styles.row },
            h(Button, {
              label: t('portrait.user'),
              onClick: () => void run(`${COMMAND} portrait`),
              disabled: busy,
            }),
            h(Button, {
              label: t('portrait.assistant'),
              onClick: () => void run(`${COMMAND} self`),
              disabled: busy,
            }),
          ),
          outputBox(t('portrait.empty')),
        );
      } else {
        tabBody = h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
          h(
            'div',
            { style: styles.row },
            h(Button, {
              label: t('status.refresh'),
              onClick: () => void run(`${COMMAND} stats`),
              disabled: busy,
            }),
            h(Button, {
              label: t('export.action'),
              onClick: () => void run(`${COMMAND} export`),
              disabled: busy,
            }),
          ),
          outputBox(t('status.empty')),
        );
      }

      const controls = h(
        'div',
        { style: styles.controls },
        h(
          'div',
          { style: styles.row },
          h('span', { style: styles.sectionLabel }, t('capture.title')),
          h(Button, { label: t('capture.pause'), onClick: () => void run(`${COMMAND} pause`), disabled: busy }),
          h(Button, { label: t('capture.resume'), onClick: () => void run(`${COMMAND} resume`), disabled: busy }),
        ),
        h(
          'div',
          { style: styles.row },
          h('span', { style: styles.sectionLabel }, t('consent.memory')),
          h(Button, { label: t('on'), onClick: () => void run(`${COMMAND} consent on`), disabled: busy }),
          h(Button, { label: t('off'), onClick: () => void run(`${COMMAND} consent off`), disabled: busy }),
        ),
        h(
          'div',
          { style: styles.row },
          h('span', { style: styles.sectionLabel }, t('consent.inject')),
          h(Button, { label: t('on'), onClick: () => void run(`${COMMAND} consent inject on`), disabled: busy }),
          h(Button, { label: t('off'), onClick: () => void run(`${COMMAND} consent inject off`), disabled: busy }),
        ),
        h(
          'div',
          { style: styles.row },
          h('span', { style: styles.sectionLabel }, t('consent.profile')),
          h(Button, { label: t('profile.unified'), onClick: () => void run(`${COMMAND} consent profile unified`), disabled: busy }),
          h(Button, { label: t('profile.situational'), onClick: () => void run(`${COMMAND} consent profile situational`), disabled: busy }),
          h(Button, { label: t('off'), onClick: () => void run(`${COMMAND} consent profile off`), disabled: busy }),
        ),
        h(
          'div',
          { style: styles.row },
          h('span', { style: styles.sectionLabel }, t('consent.sensitive')),
          h(Button, { label: t('on'), onClick: () => void run(`${COMMAND} consent sensitive on`), disabled: busy }),
          h(Button, { label: t('off'), onClick: () => void run(`${COMMAND} consent sensitive off`), disabled: busy }),
        ),
        h(
          'div',
          { style: styles.clear },
          h('span', null, `${t('clear.title')}: ${t('clear.hint')}`),
          h('code', { style: styles.code }, `${COMMAND} migrate mode=strip confirm=true`),
        ),
        h('div', { style: styles.note }, t('note.commandLog')),
      );

      return h(
        'section',
        {
          style: styles.root,
          'data-dynamic-memory-panel': 'open',
          'aria-label': t('title'),
        },
        header,
        h('div', { style: styles.body }, tabs, tabBody, controls),
      );
    }

    /** Register the panel on the composer's session-scoped dock slot. */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dynamic-memory: dictionaries');
      const t = ctx.locale.bind(NS);
      ctx.slots.inject(SLOT, () =>
        ctx.slots.register(
          {
            name: SLOT,
            id: ENTRY_ID,
            order: 30,
            locale: NS,
            inject: (sessionId) => ({
              t,
              sessionId,
              exec: async (line) => {
                if (!sessionId) return { ok: false, error: { code: 'no-session', message: t('error.session') } };
                return ctx.remote.commands.execute(sessionId, line, []);
              },
            }),
          },
          MemoryPanel,
        ),
      );
    }

    return { inject: ['slots', 'remote', 'remote.commands', 'locale'], apply };
  },
});
