window.__ModuleLoader__.load({
  id: '@local/dsh-mobile-link',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const NS = 'mobile-link';
    const PANEL_ID = 'mobile-link';

    /** How often the panel re-reads pairing state; the QR itself changes only on rotation. */
    const POLL_MS = 2500;

    const dicts = {
      zh: {
        title: '手机联动',
        subtitle: '扫码把手机接上这台电脑',
        scanning: '用手机端「扫一扫」对准二维码',
        expiresIn: '还剩 {s}',
        waitingRelay: '还没配置中继',
        relayHint:
          '留空就行：这台电脑会自己起一个中继，手机在同一局域网里扫码即可连上。只有手机走流量、或不在同一网络时，才需要填一个两端都能访问的地址。',
        relayLocal: '本机中继',
        relayExternal: '外部中继',
        switchedFrom: '原中继 {relay} 连不上，已自动改用本机中继',
        relayOnline: '中继在线',
        relayOffline: '中继离线',
        relayMissing: '未配置中继',
        connectedNow: '手机在线',
        noPhone: '暂无手机连接',
        devices: '已配对设备',
        noDevices: '还没有手机配对过',
        remove: '移除',
        reset: '重置配对',
        resetHint: '重置后房间号和口令都会变，手机要重新填一次',
        labelRelay: '中继地址',
        labelRoom: '房间号',
        labelKey: '中继口令',
        copy: '复制',
        copied: '已复制',
        relayLabel: '中继地址',
        relayPlaceholder: '留空 = 本机自建中继，或填 https://relay.example.com',
        save: '保存',
        saving: '保存中…',
        saved: '已保存',
        loadFailed: '读取配对状态失败：',
        qrFailed: '二维码生成失败：',
        lastSeen: '最近连接',
        never: '从未连接',
        justNow: '刚刚',
        minutesAgo: '{n} 分钟前',
        hoursAgo: '{n} 小时前',
        daysAgo: '{n} 天前',
        confirmReset: '再点一次确认重置',
        removing: '移除中…',
        resetting: '重置中…',
        removeDone: '已移除该设备',
        resetDone: '已重置：房间号和口令已更换，手机需要重新配对',
        opFailed: '操作失败：',
        room: '房间',
        platform: '平台',
        start: '启动联动',
        starting: '正在启动…',
        stopping: '正在停止…',
        stop: '停止联动',
        stoppedTitle: '联动未启动',
        stoppedHint: '点下面按钮启动，之后这里会显示中继地址、房间号和口令。',
        startedHint: '手机打开「设置 → 连接宿主机」，填下面三项即可连上，不用扫码',
        startFailed: '启动失败：',
      },
      en: {
        title: 'Mobile',
        subtitle: 'Pair your phone with this desktop',
        scanning: 'Point the phone app at this code',
        expiresIn: 'expires in {s}',
        waitingRelay: 'No relay configured',
        relayHint:
          'Leave it empty: this desktop hosts a relay itself, and a phone on the same network can scan straight in. Only fill an address when the phone is on mobile data or elsewhere — use relay/server.mjs or a public relay both ends can reach.',
        relayLocal: 'hosted here',
        relayExternal: 'external relay',
        switchedFrom: 'The old relay {relay} stopped answering — using the one hosted here',
        relayOnline: 'relay online',
        relayOffline: 'relay offline',
        relayMissing: 'relay not set',
        connectedNow: 'phone online',
        noPhone: 'no phone connected',
        devices: 'Paired phones',
        noDevices: 'No phone paired yet',
        remove: 'Remove',
        reset: 'Reset pairing',
        resetHint: 'Reset changes both room and key — every phone has to be filled in again',
        labelRelay: 'Relay address',
        labelRoom: 'Room',
        labelKey: 'Room key',
        copy: 'Copy',
        copied: 'Copied',
        relayLabel: 'Relay address',
        relayPlaceholder: 'Empty = hosted here, or https://relay.example.com',
        save: 'Save',
        saving: 'Saving…',
        saved: 'Saved',
        loadFailed: 'Could not read pairing state: ',
        qrFailed: 'Could not build the QR code: ',
        lastSeen: 'Last seen',
        never: 'never',
        justNow: 'just now',
        minutesAgo: '{n} min ago',
        hoursAgo: '{n} h ago',
        daysAgo: '{n} d ago',
        confirmReset: 'Click again to reset',
        removing: 'Removing…',
        resetting: 'Resetting…',
        removeDone: 'Device removed',
        resetDone: 'Reset done: room and key changed, re-pair the phone',
        opFailed: 'Operation failed: ',
        room: 'Room',
        platform: 'Platform',
        start: 'Start linking',
        starting: 'Starting…',
        stopping: 'Stopping…',
        stop: 'Stop linking',
        stoppedTitle: 'Linking is off',
        stoppedHint: 'Press the button below; the relay address, room and key appear here.',
        startedHint: 'On the phone: Settings → Connect host, then fill in the three values below',
        startFailed: 'Could not start: ',
      },
    };

    function apiUrl(routePath) {
      if (typeof document === 'undefined') return routePath;
      const url = new URL(routePath, document.baseURI);
      url.hash = '';
      return url.pathname + url.search;
    }

    async function call(path, options) {
      const response = await fetch(apiUrl(path), {
        cache: 'no-store',
        method: options?.method ?? 'GET',
        headers: options?.body === undefined ? undefined : { 'content-type': 'application/json' },
        body: options?.body === undefined ? undefined : JSON.stringify(options.body),
      });
      const text = await response.text();
      let payload;
      try {
        payload = text.length > 0 ? JSON.parse(text) : {};
      } catch {
        payload = { ok: false, error: text.slice(0, 200) };
      }
      if (!response.ok && payload?.error === undefined) payload.error = `http-${response.status}`;
      return payload;
    }

    function ago(ms, t) {
      if (!ms) return t('never');
      const delta = Date.now() - ms;
      if (delta < 60_000) return t('justNow');
      if (delta < 3_600_000) return t('minutesAgo', { n: Math.floor(delta / 60_000) });
      if (delta < 86_400_000) return t('hoursAgo', { n: Math.floor(delta / 3_600_000) });
      return t('daysAgo', { n: Math.floor(delta / 86_400_000) });
    }

    /**
     * One line of the login the phone needs. The three values are the whole
     * handshake now: the room key is the room's secret, so typing it proves the
     * same thing a scanned one-time code did — and it does not expire in five
     * minutes, which is what made the code unusable for a human to retype.
     */
    function CredRow({ label, value, copyLabel, copiedLabel }) {
      const [copied, setCopied] = React.useState(false);
      const copy = async () => {
        if (!value) return;
        try {
          await navigator.clipboard.writeText(value);
        } catch {
          // Electron without clipboard permission: fall back to the old trick.
          const box = document.createElement('textarea');
          box.value = value;
          box.style.position = 'fixed';
          box.style.opacity = '0';
          document.body.appendChild(box);
          box.select();
          document.execCommand('copy');
          box.remove();
        }
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      };
      return h(
        'div',
        { className: 'ml-cred-row' },
        h('div', { className: 'ml-cred-label' }, label),
        h('code', { className: 'ml-cred-value' }, value || '—'),
        h(
          'button',
          { className: 'ml-btn ml-btn-ghost ml-cred-copy', disabled: !value, onClick: copy },
          copied ? copiedLabel : copyLabel,
        ),
      );
    }

    function Badge({ tone, children }) {
      return h('span', { className: `ml-badge ml-badge-${tone}` }, children);
    }

    function LinkPanel({ t }) {
      const [state, setState] = React.useState(null);
      const [error, setError] = React.useState('');
      const [relayDraft, setRelayDraft] = React.useState('');
      const [relaySaving, setRelaySaving] = React.useState(false);
      const [relaySaved, setRelaySaved] = React.useState(false);
      const [resetArmed, setResetArmed] = React.useState(false);
      const [busy, setBusy] = React.useState('');
      const [notice, setNotice] = React.useState('');
      const [now, setNow] = React.useState(Date.now());

      const refresh = React.useCallback(async () => {
        const payload = await call('/mobile-link/payload');
        if (payload?.ok) {
          setState(payload);
          setError('');
          setRelayDraft((current) => (current.length > 0 ? current : payload.relay ?? ''));
        } else {
          setError(payload?.error ?? 'unknown');
        }
      }, []);

      React.useEffect(() => {
        let alive = true;
        const tick = async () => {
          if (!alive) return;
          await refresh();
          setNow(Date.now());
        };
        void tick();
        const timer = setInterval(tick, POLL_MS);
        return () => {
          alive = false;
          clearInterval(timer);
        };
      }, [refresh]);

      const saveRelay = async () => {
        setRelaySaving(true);
        setRelaySaved(false);
        const payload = await call('/mobile-link/relay', { method: 'POST', body: { relay: relayDraft } });
        setRelaySaving(false);
        if (payload?.ok) {
          setRelaySaved(true);
          await refresh();
          setTimeout(() => setRelaySaved(false), 1800);
        } else {
          setError(payload?.error ?? 'save-failed');
        }
      };

      const removeDevice = async (id) => {
        setBusy(`remove-${id}`);
        setError('');
        setNotice('');
        try {
          const payload = await call('/mobile-link/device/remove', { method: 'POST', body: { id } });
          if (payload?.ok) {
            setNotice(t('removeDone'));
            setTimeout(() => setNotice(''), 2500);
          } else {
            setError(`${t('opFailed')}${payload?.error ?? 'unknown'}`);
          }
        } catch (err) {
          setError(`${t('opFailed')}${err?.message ?? err}`);
        }
        await refresh();
        setBusy('');
      };

      const resetPairing = async () => {
        if (!resetArmed) {
          setResetArmed(true);
          setTimeout(() => setResetArmed(false), 4000);
          return;
        }
        setResetArmed(false);
        setBusy('reset');
        setError('');
        setNotice('');
        try {
          const payload = await call('/mobile-link/reset', { method: 'POST', body: {} });
          if (payload?.ok) {
            setNotice(t('resetDone'));
            setTimeout(() => setNotice(''), 4500);
          } else {
            setError(`${t('opFailed')}${payload?.error ?? 'unknown'}`);
          }
        } catch (err) {
          setError(`${t('opFailed')}${err?.message ?? err}`);
        }
        await refresh();
        setBusy('');
      };

      /** Start linking: honour a typed address, otherwise let the desktop host one. */
      const startLink = async () => {
        setBusy('start');
        setError('');
        setNotice('');
        const draft = relayDraft.trim().replace(/\/+$/, '');
        if (draft.length > 0 && draft !== (state?.relay ?? '')) {
          await call('/mobile-link/relay', { method: 'POST', body: { relay: draft } });
        }
        const payload = await call('/mobile-link/start', { method: 'POST', body: {} });
        setBusy('');
        if (payload?.ok) {
          if (payload.switchedFrom) setNotice(t('switchedFrom', { relay: payload.switchedFrom }));
          await refresh();
        } else {
          setError(`${t('startFailed')}${payload?.error ?? 'unknown'}`);
        }
      };

      const stopLink = async () => {
        setBusy('stop');
        await call('/mobile-link/stop', { method: 'POST', body: {} });
        setBusy('');
        await refresh();
      };

      if (state === null && error.length === 0) {
        return h('div', { className: 'ml-root' }, h('div', { className: 'ml-muted' }, '…'));
      }

      const relayTone = state?.relayHealth?.reachable ? 'ok' : state?.relay ? 'warn' : 'idle';
      const relayText = !state?.relay
        ? t('relayMissing')
        : state.relayHealth?.reachable
          ? t('relayOnline')
          : t('relayOffline');
      const devices = state?.devices ?? [];

      return h(
        'div',
        { className: 'ml-root' },
        h(
          'div',
          { className: 'ml-head' },
          h('div', null, h('div', { className: 'ml-title' }, t('title')), h('div', { className: 'ml-sub' }, t('subtitle'))),
          h(
            'div',
            { className: 'ml-badges' },
            h(Badge, { tone: relayTone }, relayText),
            h(Badge, { tone: state?.phoneOnline ? 'ok' : 'idle' }, state?.phoneOnline ? t('connectedNow') : t('noPhone')),
          ),
        ),

        error.length > 0 ? h('div', { className: 'ml-error' }, t('loadFailed'), error) : null,
        notice.length > 0 ? h('div', { className: 'ml-notice' }, notice) : null,

        h(
          'div',
          { className: 'ml-card ml-pair' },
          state?.enabled
            ? h(
              'div',
              { className: 'ml-cred' },
              h(CredRow, {
                label: t('labelRelay'),
                value: state?.relay ?? '',
                copyLabel: t('copy'),
                copiedLabel: t('copied'),
              }),
              h(CredRow, {
                label: t('labelRoom'),
                value: state?.room ?? '',
                copyLabel: t('copy'),
                copiedLabel: t('copied'),
              }),
              h(CredRow, {
                label: t('labelKey'),
                value: state?.key ?? '',
                copyLabel: t('copy'),
                copiedLabel: t('copied'),
              }),
            )
            : h(
              'div',
              { className: 'ml-particle-off' },
              h('div', { className: 'ml-particle-off-title' }, t('stoppedTitle')),
            ),
          h('div', { className: 'ml-pair-hint' }, state?.enabled ? t('startedHint') : t('stoppedHint')),
          h(
            'div',
            { className: 'ml-pair-actions' },
            h(
              'button',
              {
                className: state?.enabled ? 'ml-btn ml-btn-danger' : 'ml-btn ml-btn-primary ml-btn-lg',
                disabled: busy !== '',
                onClick: state?.enabled ? stopLink : startLink,
              },
              busy === 'start' ? t('starting') : busy === 'stop' ? t('stopping') : state?.enabled ? t('stop') : t('start'),
            ),
          ),
        ),

        !state?.relay
          ? h(
            'div',
            { className: 'ml-card ml-note' },
            h('div', { className: 'ml-note-title' }, t('waitingRelay')),
            h('div', { className: 'ml-note-body' }, t('relayHint')),
          )
          : null,

        h(
          'div',
          { className: 'ml-card' },
          h('div', { className: 'ml-section' }, `${t('devices')} · ${devices.length}`),
          devices.length === 0
            ? h('div', { className: 'ml-muted' }, t('noDevices'))
            : h(
              'ul',
              { className: 'ml-devices' },
              devices.map((device) =>
                h(
                  'li',
                  { key: device.id, className: 'ml-device' },
                  h(
                    'div',
                    { className: 'ml-device-main' },
                    h('div', { className: 'ml-device-name' }, device.name || device.id.slice(0, 8)),
                    h(
                      'div',
                      { className: 'ml-device-meta' },
                      [device.platform, `${t('lastSeen')} ${ago(device.lastSeenAt, t)}`].filter(Boolean).join(' · '),
                    ),
                  ),
                  h('button', { className: 'ml-btn ml-btn-ghost', disabled: busy !== '', onClick: () => removeDevice(device.id) }, busy === `remove-${device.id}` ? t('removing') : t('remove')),
                ),
              ),
            ),
          h(
            'div',
            { className: 'ml-danger-row' },
            h('button', { className: `ml-btn ${resetArmed ? 'ml-btn-danger' : 'ml-btn-ghost'}`, disabled: busy !== '', onClick: resetPairing }, busy === 'reset' ? t('resetting') : resetArmed ? t('confirmReset') : t('reset')),
            h('span', { className: 'ml-muted' }, t('resetHint')),
          ),
        ),

        h(
          'div',
          { className: 'ml-card' },
          h('div', { className: 'ml-section' }, t('relayLabel')),
          h(
            'div',
            { className: 'ml-relay-row' },
            h('input', {
              className: 'ml-input',
              value: relayDraft,
              placeholder: t('relayPlaceholder'),
              spellCheck: false,
              autoComplete: 'off',
              onChange: (event) => setRelayDraft(event.target.value),
            }),
            h('button', { className: 'ml-btn ml-btn-primary', disabled: relaySaving, onClick: saveRelay }, relaySaving ? t('saving') : relaySaved ? t('saved') : t('save')),
          ),
          state?.room
            ? h(
              'div',
              { className: 'ml-muted ml-room' },
              [
                state.relay ? (state.relayMode === 'embedded' ? t('relayLocal') : t('relayExternal')) : '',
                `${t('room')} ${state.room}`,
              ]
                .filter(Boolean)
                .join(' · '),
            )
            : null,
        ),
      );
    }

    const css = `
.ml-root { display: flex; flex-direction: column; gap: 14px; padding: 22px 26px 40px; max-width: 720px; margin: 0 auto; width: 100%; box-sizing: border-box; }
.ml-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.ml-title { font-size: 18px; font-weight: 650; letter-spacing: .01em; }
.ml-sub { font-size: 12.5px; opacity: .62; margin-top: 3px; }
.ml-badges { display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
.ml-badge { font-size: 11px; padding: 3px 8px; border-radius: 999px; white-space: nowrap; }
.ml-badge-ok { background: rgba(45, 164, 78, .14); color: #2da44e; }
.ml-badge-warn { background: rgba(212, 133, 15, .15); color: #b7791f; }
.ml-badge-idle { background: rgba(128, 128, 128, .14); opacity: .8; }
.ml-card { border: 1px solid rgba(128,128,128,.18); border-radius: 14px; padding: 16px; display: flex; flex-direction: column; gap: 10px; }
.ml-pair { align-items: center; }
.ml-qr-error { color: #d1242f; font-size: 12px; }
.ml-notice { font-size: 12.5px; padding: 8px 12px; border-radius: 10px; background: rgba(212, 133, 15, .12); color: #b7791f; }
/* Three rows of text instead of a code: readable, copyable, and it survives a
   screenshot that loses focus — which a QR code on a dim panel does not. */
.ml-cred { width: 100%; display: flex; flex-direction: column; gap: 8px; }
.ml-cred-row { display: flex; align-items: center; gap: 10px; }
.ml-cred-label { flex: 0 0 72px; font-size: 12px; opacity: .55; }
.ml-cred-value {
  flex: 1; min-width: 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12.5px; padding: 7px 10px; border-radius: 9px;
  background: rgba(128, 128, 128, .09); border: 1px solid rgba(128, 128, 128, .16);
  overflow-x: auto; white-space: nowrap; user-select: all;
}
.ml-cred-copy { flex: 0 0 auto; min-width: 52px; }
.ml-particle-off {
  width: 260px; height: 260px; border-radius: 22px; display: flex; align-items: center; justify-content: center;
  border: 1px dashed rgba(130, 146, 190, .45); background: rgba(120, 140, 200, .05);
}
.ml-particle-off-title { font-size: 13px; opacity: .55; }
.ml-pair-actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; justify-content: center; }
.ml-btn-lg { padding: 10px 22px; font-size: 13.5px; border-radius: 10px; }
.ml-pair-hint { font-size: 12.5px; opacity: .7; }
.ml-note-title { font-size: 13px; font-weight: 600; }
.ml-note-body { font-size: 12.5px; opacity: .68; line-height: 1.6; }
.ml-section { font-size: 12px; letter-spacing: .04em; text-transform: uppercase; opacity: .55; }
.ml-muted { font-size: 12.5px; opacity: .55; }
.ml-devices { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.ml-device { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.ml-device-name { font-size: 13.5px; }
.ml-device-meta { font-size: 11.5px; opacity: .55; margin-top: 2px; }
.ml-btn { border: 1px solid rgba(128,128,128,.26); background: transparent; color: inherit; font: inherit; font-size: 12.5px; padding: 6px 12px; border-radius: 9px; cursor: pointer; }
.ml-btn:hover { background: rgba(128,128,128,.1); }
.ml-btn:disabled { opacity: .5; cursor: default; }
.ml-btn-primary { background: #4d6bfe; border-color: #4d6bfe; color: #fff; }
.ml-btn-primary:hover { background: #3f5be6; }
.ml-btn-danger { border-color: #d1242f; color: #d1242f; }
.ml-btn-ghost { opacity: .85; }
.ml-danger-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.ml-relay-row { display: flex; gap: 8px; }
.ml-input { flex: 1; min-width: 0; font: inherit; font-size: 12.5px; padding: 7px 10px; border-radius: 9px; border: 1px solid rgba(128,128,128,.28); background: rgba(128,128,128,.06); color: inherit; }
.ml-input:focus { outline: none; border-color: #4d6bfe; }
.ml-room { font-variant-numeric: tabular-nums; }
@media (prefers-color-scheme: dark) {
  .ml-card { border-color: rgba(255,255,255,.12); }
}
`;

    function LinkIcon(size) {
      // Phone outline with a link dot: readable at 20 px.
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true' },
        h('rect', { x: 6.5, y: 2.5, width: 11, height: 19, rx: 2.6, stroke: 'currentColor', strokeWidth: 1.6 }),
        h('path', { d: 'M10 5.4h4', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }),
        h('circle', { cx: 12, cy: 12.2, r: 2.1, stroke: 'currentColor', strokeWidth: 1.6 }),
        h('path', { d: 'M12 14.3v2.2', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }),
      );
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, dicts), 'mobile-link: dictionaries');
        ctx.effect(() => {
          const style = document.createElement('style');
          style.dataset.plugin = '@local/dsh-mobile-link';
          style.dataset.pluginCss = 'mobile-link/panel';
          style.textContent = css;
          document.head.appendChild(style);
          return () => style.remove();
        }, 'mobile-link: styles');

        const t = ctx.locale.bind(NS);

        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            { name: 'sidebar.panellist', id: PANEL_ID, order: 88, label: () => t('title'), inject: () => ({ t }) },
            () => LinkIcon(20),
          ),
        );

        ctx.slots.inject('main', () =>
          ctx.slots.register(
            { name: 'main', key: PANEL_ID, inject: () => ({ t }) },
            () => h(LinkPanel, { t }),
          ),
        );
      },
    };
  },
});
