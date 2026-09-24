    function TtsCard(props) {
      const t = (props && props.t) || ((key) => key)
      const [open, setOpen] = React.useState(false)
      return React.createElement('li', { className: 'dts-card' },
        React.createElement('button', {
          type: 'button',
          className: 'dts-head',
          onClick: () => setOpen(!open),
          'aria-expanded': open,
        },
          React.createElement('div', { className: 'dts-headText' },
            React.createElement('div', { className: 'dts-title' }, t('title')),
            React.createElement('div', { className: 'dts-sub' }, t('cardHint')),
          ),
          ChevronIcon
            ? React.createElement(ChevronIcon, { className: 'dts-chev' + (open ? ' dts-chevOpen' : '') })
            : React.createElement('svg', {
                className: 'dts-chev' + (open ? ' dts-chevOpen' : ''),
                width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none',
              },
                React.createElement('path', {
                  d: 'M4 6l4 4 4-4', stroke: 'currentColor', 'stroke-width': 1.5,
                  'stroke-linecap': 'round', 'stroke-linejoin': 'round',
                }),
              ),
        ),
        open ? React.createElement('div', { className: 'dts-body' },
          React.createElement(ErrorBoundary, null,
            React.createElement(TtsSection, Object.assign({}, props, { compact: true, ctx: props && props.ctx })),
          ),
        ) : null,
      )
    }

    // Input-dock button: shows what is playing, stop control, and recents for replay.
    function SpeakerControl(props) {
    // A slot with `locale` injects translations into props; the fallback is the
    // binder created at registration, in case the slot drops translations.
      const t = (props && props.t) || fallbackDockText
      const p = usePlayer()
      const [showList, setShowList] = React.useState(false)
      // "Is she speaking right now" has to cover BOTH playback paths.
      //
      // `audio` and `queue` are the WAV path's evidence: an <audio> element and a
      // queue of pending blobs. Progressive PCM has neither — its blocks are handed
      // straight to the AudioContext as they arrive and no <audio> element is ever
      // created — so with only those three terms the dock rendered `null` for the
      // whole of every PCM reply and the pause/stop controls disappeared from the
      // UI. That was a real regression: the transport was promoted without the dock
      // being taught about the second path.
      //
      // `speaking` is the transport-independent flag the plugin already maintains
      // (and that dsh-voice's barge-in gate reads), so it is the honest term to add.
      // `pcmPlaying` covers the tail where the bytes have all been scheduled but the
      // sound has not finished, which is when the controls are most wanted.
      const active = !!p.audio || p.queue.length > 0 || p.busy || !!p.speaking || !!p.pcmPlaying
      const [, force] = React.useReducer((n) => n + 1, 0)
      if (!active && !showList) return null
      const lists = recent.list()
      const row = (text, starred) => React.createElement('div', { className: 'dts-row', key: text.slice(0, 24) + starred },
        React.createElement('button', {
          type: 'button', className: 'dts-link', style: { flex: 1, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
          title: text,
          onClick: () => playStandalone(text), title: text,
        }, text.slice(0, 80)),
        React.createElement('button', {
          type: 'button', className: 'dts-link', title: '★',
          onClick: () => { recent.toggleFav(text); force() },
        }, starred ? '★' : '☆'),
        React.createElement('button', {
          type: 'button', className: 'dts-link', title: t('exportAudio') || 'Export',
          onClick: () => exportAudioClip(text),
        }, '⤓'),
      )
      return React.createElement('div', { style: { position: 'relative', display: 'inline-flex', gap: '4px', alignItems: 'center' } },
        React.createElement('button', {
          type: 'button', className: 'dts-link', title: t('recent') || 'Recent',
          onClick: () => setShowList((v) => !v),
        }, '☰'),
        showList ? React.createElement('div', {
          className: 'dts-wrap',
          style: { position: 'absolute', bottom: '36px', right: 0, zIndex: 30, maxHeight: '320px', overflowY: 'auto', background: 'var(--dsw-alias-bg-layer-2)', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '12px', padding: '10px 12px', minWidth: '260px', flexDirection: 'column', gap: '6px', display: 'flex' },
        },
          lists.favs.length ? React.createElement('div', { className: 'dts-h' }, '★') : null,
          lists.favs.map((text) => row(text, true)),
          React.createElement('div', { className: 'dts-h' }, '⟳'),
          lists.items.filter((x) => !lists.favs.includes(x)).map((text) => row(text, false)),
          !lists.items.length ? React.createElement('span', { className: 'dts-sub' }, t('recentEmpty') || 'No recent speech yet') : null,
        ) : null,
        React.createElement('button', {
          type: 'button',
          className: 'dts-link',
          title: p.paused ? t('dockResume') : t('dockPause'),
          onClick: togglePause,
        }, p.paused ? '▶' : '❚❚'),
        React.createElement('button', {
          type: 'button',
          className: 'dts-link',
          title: t('dockStop'),
          onClick: stopPlayback,
        }, '■'),
        React.createElement('button', {
          type: 'button',
          className: 'dts-link',
          title: t('exportAudio') || 'Export clip',
          onClick: () => exportAudioClip(player.lastText),
        }, '⤓'),
      )
    }

    /**
     * Fallback translator for the dock.
     *
     * Bound at registration for the page lifetime. The core draws the slot label;
     * props.t never reaches it, so the binder is the only way to give it a language.
     */
    let fallbackDockText = (key) => key

    function registerSpeaker(ctx) {
    // `locale` in the slot descriptor is how core injects translations into props.
    // Without it the dock would show raw keys only.
      fallbackDockText = ctx.locale.bind(NS)
      // WHICH SEAT, AND WHY IT MOVED (0.4.16-local.14)
      //
      // These are three compact buttons, and they were registered into
      // `conversation.input.dock` — which the framework documents as "full-width
      // entries above the composer card", a strip built for the queue, todo and
      // goal BARS. Small controls in a bar seat is why they looked like they had
      // landed somewhere strange, and why they could not simply sit at the side.
      //
      // `conversation.input.left` is documented as "compact controls at the left of
      // the composer tool row" and had NO occupants, so it is both the intended
      // seat for this shape of control and a free one. The seat is declared by an
      // entry in `conversation.composer.bar`, so it exists whenever the composer
      // does — no change to when the controls appear, only where.
      ctx.slots.inject('conversation.input.left', () => ctx.slots.register(
        {
          name: 'conversation.input.left',
          id: '@goodandready/dsh-tts',
          locale: NS,
          order: 5,
          label: () => fallbackDockText('dockLabel'),
        },
        SpeakerControl,
      ))
    }

    function registerSettings(ctx) {
    // Dictionary packages may also register languages for other namespaces.
    // Core throws on duplicate namespace+language; an unguarded call used to
    // take down the whole plugin ("Failed to load plugins"). Register each
    // language separately: skip if taken; English still lands.
      const addLocale = (locale, dictionary) => {
        try {
          return ctx.locale.register(NS, locale, dictionary)
        } catch (alreadyTaken) {
          return () => {}
        }
      }
      ctx.effect(() => {
        const undo = [addLocale('en', en), addLocale('zh', zh)]
        return () => { for (const off of undo) off() }
      }, 'dsh-tts: locales')
    // The sidebar draws the section label, not our component: props.t never
    // reaches it, so bind the translator to the namespace ourselves.
      const t = ctx.locale.bind(NS)
    // Primary settings home is the plugin-settings tab card. The tab looks up
    // a slot by entryKey equal to the namespace name: key must equal NS or
    // the card never appears, with no log error.
      ctx.slots.inject('settings.plugin.item', () => ctx.slots.register(
        {
          name: 'settings.plugin.item',
          key: NS,
          locale: NS,
          inject: () => ({ ctx: ctx }),
        },
        TtsCard,
      ))
    }

    exports.inject = ['slots', 'settingsScope', 'locale']
    exports.apply = function apply(ctx) {
      registerSettings(ctx)
      registerSpeaker(ctx)
      ctx.effect(() => listenForVoice(), 'dsh-tts: barge-in on user speech')
      ctx.effect(() => {
        if (typeof window === 'undefined') return () => {}
        const onKey = (e) => {
          if (e.ctrlKey && e.key === 'Escape') { togglePause(); e.preventDefault() }
          else if (e.altKey && (e.code === 'KeyS' || e.key === 's' || e.key === 'S')) { stopPlayback(); e.preventDefault() }
          else if (e.altKey && e.key === 'ArrowRight') { skipCurrent(); e.preventDefault() }
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, 'dsh-tts: hotkeys')
      ctx.effect(() => {
        if (typeof window === 'undefined' || typeof EventSource === 'undefined') return () => {}
        let es = null
        let closed = false
        let attempt = 0
        let retryTimer = null
        const onItem = (e) => {
          try {
            const item = JSON.parse(e.data)
            if (!item || !item.id) return
            if (seenIds.has(item.id)) return
            seenIds.add(item.id)
            if (seenIds.size > 500) {
              const first = seenIds.values().next().value
              seenIds.delete(first)
            }
            player.queue.push(item)
            drainQueue()
          } catch { /* ignore malformed SSE frame */ }
        }
        const connect = () => {
          if (closed) return
          try {
            es = new EventSource('/dsh-tts/stream')
            es.addEventListener('open', () => { attempt = 0 })
            es.addEventListener('utterance', onItem)
            es.addEventListener('chime', onItem)
            es.onerror = () => {
              try { es.close() } catch { /* already closed */ }
              if (closed) return
              attempt += 1
              const delay = Math.min(15000, 500 * Math.pow(2, Math.min(attempt, 5)))
              retryTimer = setTimeout(connect, delay)
            }
          } catch { /* EventSource constructor failed — poll remains */ }
        }
        connect()
        return () => {
          closed = true
          if (retryTimer) clearTimeout(retryTimer)
          if (es) { try { es.close() } catch { /* already closed */ } }
        }
      }, 'dsh-tts: SSE audio stream')
      // LOCAL FORK: self-rescheduling poll instead of a fixed 1000 ms interval.
      // The delay is read after every poll, so live sentence streaming can lower
      // it (default 150 ms) as soon as the first /status answer arrives, and the
      // upstream 1000 ms remains the default otherwise.
      ctx.effect(() => {
        let timer = null
        let closed = false
        const tick = async () => {
          if (closed) return
          try { await pollPending() } catch { /* host restarting */ }
          if (closed) return
          const delay = typeof player.pollMs === 'number' && player.pollMs > 0 ? player.pollMs : 1000
          timer = setTimeout(tick, delay)
        }
        timer = setTimeout(tick, 250)
        return () => { closed = true; if (timer) clearTimeout(timer) }
      }, 'dsh-tts: poll pending audio')
    }
    return module.exports
  },
})

// ModelManager UI placeholder - manual install buttons for Kokoro/F5
// Actual implementation would show download progress and status

