/**
 * Client half of `dsh-job-monitor`.
 *
 * A dedicated background-task page: it registers a `main` panel (and its
 * `sidebar.panellist` icon) and lists every job the client can see, grouped and
 * filterable, with a live output pane for the selected job.
 *
 * It joins the shipped job controller's client service (`ctx.jobs`) rather than
 * opening its own `remote.job` streams: rosters are reference counted per
 * session and observations are shared per job, so this page and the shipped
 * header list watch the same streams instead of duplicating them, and both
 * resume whole after a reconnect.
 *
 * `JobView` carries no numeric progress field (only a free-text `progress`
 * line), so a percentage is shown only when a fraction can be read from that
 * text; everything else renders an indeterminate bar next to live counters.
 */
window.__ModuleLoader__.load({
  id: 'dsh-job-monitor',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** Registered panel key and sidebar entry id. */
    const PANEL_ID = 'job-monitor';
    /** Locale namespace for every string this page renders. */
    const NS = 'job-monitor';
    /** Largest number of sessions the page opens roster streams for. */
    const MAX_WATCH = 40;
    /** Largest number of running jobs whose output is observed at once. */
    const MAX_OBSERVE = 4;
    const SETTING_WATCH = 'dsh-job-monitor:watch-limit';
    const SETTING_OBSERVE = 'dsh-job-monitor:observe-limit';
    const SETTING_DENSITY = 'dsh-job-monitor:density';
    const SETTING_PINS = 'dsh-job-monitor:pins';

    /**
     * Clamp a stored numeric setting. A missing, non-numeric or out-of-range value
     * falls back to the default instead of silently breaking the watch loop.
     */
    function clampSetting(raw, fallback, min, max) {
      const value = Number(raw);
      if (raw === null || raw === undefined || raw === '' || !Number.isFinite(value)) return fallback;
      return Math.min(max, Math.max(min, Math.round(value)));
    }

    /** A number persisted to localStorage, clamped to [min, max]. */
    function useNumberSetting(key, fallback, min, max) {
      const [value, setValue] = React.useState(() =>
        clampSetting(readStored(key, ''), fallback, min, max),
      );
      const update = React.useCallback(
        (next) => {
          const clamped = clampSetting(next, value, min, max);
          writeStored(key, String(clamped));
          setValue(clamped);
        },
        [key, min, max, value],
      );
      return [value, update];
    }
    /** Default upper bound, kept for the config hint. */
    const DEFAULT_WATCH = MAX_WATCH;
    /** Stable empty roster so a session with no jobs keeps one array identity. */
    const EMPTY = [];
    /** Window used to turn observed progress into a remaining time. */
    const RATE_WINDOW_MS = 20000;
    /** Silence long enough to call a running job stalled. */
    const STALL_MS = 90000;
    /** How long an armed stop waits for its confirming press. */
    const KILL_ARM_MS = 3000;
    /** How long a failed stop keeps its hint before the control resets. */
    const KILL_FAILED_MS = 4000;
    /** How long a pending stop keeps its control disabled before it is released. */
    const KILL_PENDING_MS = 6000;
    /** Characters of output rendered into the DOM; the rest stays copyable. */
    const RENDER_TAIL = 48 * 1024;

    const MONO = 'ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace';

    const CSS = `
.jp-page{display:flex;flex-direction:column;gap:12px;height:100%;min-height:0;padding:18px 20px 16px;box-sizing:border-box;color:var(--dsw-alias-label-primary);font-size:13px;overflow:hidden}
.jp-head{display:flex;align-items:center;gap:10px;flex:none}
.jp-title{font-size:16px;line-height:22px;font-weight:600;margin:0;letter-spacing:.01em}
.jp-sub{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);margin-left:2px;white-space:nowrap}
.jp-toolbar{display:flex;align-items:center;gap:8px;margin-left:auto}
.jp-search{height:30px;width:210px;padding:0 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;outline:none}
.jp-search:focus{border-color:var(--dsw-alias-brand-primary)}
.jp-search::placeholder{color:var(--dsw-alias-label-secondary)}

.jp-stats{display:flex;gap:10px;flex-wrap:wrap;flex:none}
.jp-stat{display:flex;flex-direction:column;gap:1px;min-width:104px;padding:8px 12px;border-radius:10px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);text-align:left;font:inherit;color:inherit;cursor:pointer}
.jp-stat:hover{border-color:var(--dsw-alias-border-l2)}
.jp-stat[aria-pressed="true"]{border-color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 8%,var(--dsw-alias-bg-layer-1))}
.jp-stat-static{cursor:default}
.jp-stat-static:hover{border-color:var(--dsw-alias-border-l1)}
.jp-stat-label{font-size:11px;line-height:15px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.jp-stat-value{font-size:19px;line-height:24px;font-weight:600;font-variant-numeric:tabular-nums}

.jp-filters{display:flex;align-items:center;gap:10px;flex:none;flex-wrap:wrap}
.jp-chips{display:inline-flex;gap:2px;padding:2px;border-radius:8px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1)}
.jp-chip{height:24px;padding:0 10px;border:0;border-radius:6px;background:0 0;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer}
.jp-chip:hover{color:var(--dsw-alias-label-primary)}
.jp-chip[aria-pressed="true"]{background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);box-shadow:inset 0 0 0 1px var(--dsw-alias-border-l2)}
.jp-group{display:inline-flex;align-items:center;gap:4px;font-size:11px;color:var(--dsw-alias-label-secondary);margin-left:auto}
.jp-group .jp-chip{font-size:11px;height:22px}

.jp-body{display:grid;grid-template-columns:minmax(0,1.1fr) minmax(0,1fr);gap:12px;flex:1;min-height:0}
@media (max-width:1040px){.jp-body{grid-template-columns:1fr}}
.jp-pane{display:flex;flex-direction:column;min-height:0;min-width:0;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);overflow:hidden}
.jp-pane-head{display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);flex:none}
.jp-list{flex:1;min-height:0;overflow:auto;padding:6px;outline:none}
.jp-section{display:flex;align-items:center;gap:6px;padding:6px 8px 2px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);position:sticky;top:-6px;background:var(--dsw-alias-bg-layer-1);z-index:1}
.jp-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;height:100%;padding:32px;text-align:center;color:var(--dsw-alias-label-secondary)}
.jp-empty-title{font-size:13px;color:var(--dsw-alias-label-primary)}
.jp-empty-hint{font-size:11px;line-height:17px;max-width:300px}

.jp-row{display:grid;grid-template-columns:minmax(0,1fr);gap:2px;width:100%;padding:7px 8px;border-radius:9px;cursor:pointer}
.jp-row:hover{background:var(--dsw-alias-bg-layer-2)}
.jp-row[aria-selected="true"]{background:var(--dsw-alias-bg-overlay);box-shadow:inset 0 0 0 1px var(--dsw-alias-border-l2)}
.jp-row-main{display:flex;align-items:center;gap:8px;min-width:0}
.jp-line2{display:flex;align-items:center;gap:6px;min-width:0;padding-left:16px;font-size:11px;line-height:15px;color:var(--dsw-alias-label-secondary)}
.jp-label{font-size:12px;line-height:17px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0}
.jp-duration{font-size:11px;line-height:17px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;flex:none}
.jp-meta{font-size:11px;line-height:15px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.jp-kind{padding:0 5px;border-radius:4px;background:var(--dsw-alias-bg-layer-2);font-size:10px;line-height:15px;flex:none}
.jp-sepdot{opacity:.45;flex:none}
.jp-tag{flex:none;padding:0 5px;border-radius:4px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:10px;line-height:15px;margin-left:2px}
.jp-history{flex:1;min-height:0;display:flex;flex-direction:column;gap:12px;padding:12px;overflow:auto}
.jp-history-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.jp-history-col{display:flex;flex-direction:column;gap:6px;min-width:0}
.jp-history-title{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary)}
.jp-history-row{display:flex;align-items:center;gap:8px;min-width:0;padding:4px 6px;border-radius:6px;background:var(--dsw-alias-bg-layer-1)}
.jp-history-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:11px/16px ui-monospace,monospace}
.jp-history-foot{display:flex;align-items:center;gap:10px;flex:none}
.jp-find{display:flex;align-items:center;gap:8px;flex:none;padding:6px 8px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.jp-find input{flex:1;height:26px;padding:0 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;outline:none}
.jp-hit{background:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-bg-base);border-radius:2px}
.jp-pin{flex:none;border:0;background:0 0;padding:0;width:18px;height:18px;line-height:18px;border-radius:4px;color:var(--dsw-alias-label-secondary);opacity:.5;cursor:pointer;font-size:12px}
.jp-pin:hover{opacity:1;background:var(--dsw-alias-bg-layer-2)}
.jp-pin-on{opacity:1;color:var(--dsw-alias-state-warn-primary)}
.jp-compact .jp-line2{display:none}
.jp-compact .jp-row{padding-top:5px;padding-bottom:5px}
.jp-badge{flex:none;padding:0 6px;border-radius:999px;font-size:10px;line-height:16px}
.jp-badge-warn{background:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-bg-base)}
.jp-settings{display:flex;align-items:center;gap:14px;flex-wrap:wrap;flex:none;padding:8px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);font-size:12px;color:var(--dsw-alias-label-secondary)}
.jp-setting{display:inline-flex;align-items:center;gap:6px}
.jp-setting input{width:64px;height:24px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;padding:0 6px}
.jp-setting-hint{flex:1 1 100%;color:var(--dsw-alias-label-secondary);opacity:.85}
.jp-gear{flex:none;border:1px solid var(--dsw-alias-border-l1)}
.jp-crash-detail{flex:1;margin:10px 0 0;padding:10px;overflow:auto;border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-state-error-primary);font:12px/1.5 ui-monospace,monospace;white-space:pre-wrap}
.jp-session{border:0;background:0 0;padding:0;font:inherit;cursor:pointer;border-radius:4px}
.jp-session:hover{color:var(--dsw-alias-label-primary);text-decoration:underline}

.jp-dot{width:8px;height:8px;border-radius:50%;flex:none;background:var(--dsw-alias-state-idle-primary)}
.jp-dot-running{background:var(--dsw-alias-brand-primary);animation:jp-pulse 1.6s ease-in-out infinite}
.jp-dot-stopping,.jp-dot-killed,.jp-dot-warn{background:var(--dsw-alias-state-warn-primary)}
.jp-dot-completed{background:var(--dsw-alias-state-success-primary)}
.jp-dot-failed{background:var(--dsw-alias-state-error-primary)}
.jp-dot-idle{background:var(--dsw-alias-state-idle-primary)}
@keyframes jp-pulse{0%,100%{opacity:1}50%{opacity:.3}}

.jp-bar{position:relative;width:140px;height:8px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);overflow:hidden;flex:none;box-shadow:inset 0 0 0 1px var(--dsw-alias-border-l1)}
.jp-fill{display:block;height:100%;border-radius:999px;background:var(--dsw-alias-brand-primary);transition:width .35s ease}
.jp-fill-done{background:var(--dsw-alias-state-success-primary)}
.jp-fill-warn{background:var(--dsw-alias-state-warn-primary)}
.jp-fill-failed{background:var(--dsw-alias-state-error-primary)}
.jp-bar-indeterminate .jp-fill{width:38%;animation:jp-slide 1.4s ease-in-out infinite}
@keyframes jp-slide{0%{transform:translateX(-110%)}100%{transform:translateX(290%)}}
.jp-bar-label{display:inline-flex;justify-content:flex-end;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;min-width:52px;text-align:right;flex:none}
.jp-approx{opacity:.55;margin-right:1px}

.jp-kill{flex:none;display:inline-flex;align-items:center;justify-content:center;gap:3px;height:20px;min-width:20px;padding:0 6px;border:1px solid transparent;border-radius:6px;background:0 0;color:var(--dsw-alias-label-secondary);cursor:pointer;font:inherit;font-size:10px}
.jp-kill:hover{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.jp-kill[data-kill-state="armed"]{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.jp-kill[data-kill-state="failed"]{color:var(--dsw-alias-state-warn-primary)}
.jp-kill:disabled{opacity:.5;cursor:progress}

.jp-btn{height:28px;padding:0 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer}
.jp-btn:hover{border-color:var(--dsw-alias-border-l2)}
.jp-btn:disabled{opacity:.45;cursor:default}
.jp-btn-primary{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.jp-btn-primary:hover{border-color:var(--dsw-alias-state-error-primary)}

.jp-detail{display:flex;flex-direction:column;min-height:0}
.jp-detail-head{display:flex;flex-direction:column;gap:3px;padding:10px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:none}
.jp-detail-title{display:flex;align-items:center;gap:8px;min-width:0;font-size:12px;line-height:17px}
.jp-detail-facts{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.jp-console{position:relative;flex:1;min-height:0;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base)}
.jp-pre{margin:0;flex:1;min-height:0;overflow:auto;padding:10px 12px;color:var(--dsw-alias-label-primary);font-family:${MONO};font-size:11px;line-height:17px;white-space:pre-wrap;word-break:break-word;tab-size:2}
.jp-pre-empty{color:var(--dsw-alias-label-secondary)}
.jp-jump{position:absolute;right:12px;bottom:10px;height:22px;padding:0 9px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-secondary);font:inherit;font-size:10px;cursor:pointer}
.jp-jump:hover{color:var(--dsw-alias-label-primary)}
.jp-notice{padding:5px 12px;font-size:10px;line-height:14px;color:var(--dsw-alias-label-secondary);border-bottom:1px solid var(--dsw-alias-border-l1)}
.jp-notice-error{color:var(--dsw-alias-state-error-primary)}
.jp-actions{display:flex;align-items:center;gap:8px;padding:8px 12px;border-top:1px solid var(--dsw-alias-border-l1);flex:none;flex-wrap:wrap}
.jp-spacer{flex:1}

.jp-crash{display:flex;align-items:center;gap:8px;padding:12px;font-size:12px;color:var(--dsw-alias-label-primary)}
.jp-sr{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
.jp-page :focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}

@media (prefers-reduced-motion: reduce){
  .jp-dot-running{animation:none}
  .jp-bar-indeterminate .jp-fill{animation:none;width:60%}
  .jp-fill{transition:none}
}
`;

    /** A live job is one whose process may still produce output. */
    function isLive(job) {
      return job.status === 'running' || job.status === 'stopping';
    }

    /** A row offers an output pane while live or while it retained output. */
    function isObservable(job) {
      return isLive(job) || (job.output?.total ?? 0) > 0;
    }

    function dotClass(status) {
      return `jp-dot jp-dot-${status}`;
    }

    /** The exit-code fact the bash/pwsh tools put in a settled job's detail. */
    const EXIT_CODE = /exit code:\s*(-?\d+)/i;

    /**
     * How a settled job ended when "completed" alone is misleading: a non-zero
     * command exit is still `completed` in this job vocabulary, and `failed` is
     * reserved for a job that never ran.
     */
    function abnormalOf(job) {
      if (job.status === 'failed') return 'failed';
      if (job.status !== 'completed') return undefined;
      const match = EXIT_CODE.exec(`${job.progress ?? ''} ${job.detail ?? ''}`);
      return match !== null && Number(match[1]) !== 0 ? 'nonzero' : undefined;
    }

    /** Row marker: a non-zero exit reads as a warning, not as a clean success. */
    function rowDotClass(job) {
      return abnormalOf(job) === 'nonzero' ? dotClass('warn') : dotClass(job.status);
    }

    /** A percentage with an optional decimal, never glued to a longer number. */
    const PROGRESS_PERCENT = /(?<![\d.])(\d{1,3}(?:\.\d+)?)\s*%(?!\d)/;
    /** "step 12/75", "chunk 3/9", "part 4 of 9", "第 3/9 步". */
    const PROGRESS_KEYWORD = /(?:step|progress|chunk|part|item|file|batch|phase|block|piece|第)\s*[^\d\n]{0,12}(\d{1,6})\s*(?:\/|of|共)\s*(\d{1,6})/i;
    /** Any other "3/6" counter, used only when the line is not date-ish. */
    const PROGRESS_LOOSE = /(?<![\d/.])(\d{1,6})\s*\/\s*(\d{1,6})(?![\d/])/;
    /** Calendar/time shapes that must never be read as a fraction. */
    const DATE_LIKE = /\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}:\d{2}(?::\d{2})?/;

    /**
     * Read one line as a progress value. Percentages win; a counter with a
     * keyword ("step", "chunk", …) is trusted anywhere, a bare counter only on a
     * line that carries no date or clock (so `2026/11/05` and `12:03` can never
     * turn into a fraction).
     *
     * @param line - one output or progress line.
     * @returns ratio in [0,1] with the literal label, or undefined.
     */
    function readProgress(line) {
      const text = typeof line === 'string' ? line : '';
      if (text === '') return undefined;

      const percent = PROGRESS_PERCENT.exec(text);
      if (percent !== null) {
        const value = Number(percent[1]);
        if (Number.isFinite(value) && value >= 0 && value <= 100) {
          return { ratio: Math.min(1, value / 100), label: `${percent[1]}%` };
        }
      }

      const counter = PROGRESS_KEYWORD.exec(text) ?? (DATE_LIKE.test(text) ? null : PROGRESS_LOOSE.exec(text));
      if (counter !== null) {
        const done = Number(counter[1]);
        const total = Number(counter[2]);
        if (total >= 2 && done >= 0 && done <= total) {
          return { ratio: done / total, label: `${counter[1]}/${counter[2]}` };
        }
      }
      return undefined;
    }

    /**
     * The producer's own progress/detail line, when it reports anything.
     *
     * @param job - roster row.
     * @returns ratio in [0,1] with the literal label, or undefined.
     */
    function progressOf(job) {
      return readProgress(job.progress) ?? readProgress(job.detail);
    }

    /**
     * The newest readable progress in an output tail. It walks backwards over a
     * bounded window instead of trusting the very last line, because most tools
     * interleave their meter with ordinary log lines.
     *
     * @param text - observed output tail.
     * @returns ratio and label, or undefined when nothing in the window reads.
     */
    function progressFromOutput(text) {
      if (typeof text !== 'string' || text === '') return undefined;
      const tail = text.length > 8000 ? text.slice(-8000) : text;
      const CR = String.fromCharCode(13);
      const LF = String.fromCharCode(10);
      const lines = tail.split(CR).join(LF).split(LF);
      let scanned = 0;
      for (let index = lines.length - 1; index >= 0 && scanned < 40; index -= 1) {
        const line = lines[index];
        if (line.trim() === '') continue;
        scanned += 1;
        const found = readProgress(line);
        if (found !== undefined) return found;
      }
      return undefined;
    }

    /**
     * Live rows first in start order, then settled rows newest-first. Sorting
     * never depends on the host map's iteration order.
     */
    function sortJobs(jobs) {
      return [...jobs].sort((left, right) => {
        const liveLeft = isLive(left);
        if (liveLeft !== isLive(right)) return liveLeft ? -1 : 1;
        if (liveLeft) return left.startedAt - right.startedAt;
        const finished = (right.finishedAt ?? right.startedAt) - (left.finishedAt ?? left.startedAt);
        return finished !== 0 ? finished : left.startedAt - right.startedAt;
      });
    }

    function formatDuration(elapsedMs, t) {
      const total = Math.max(0, Math.floor(elapsedMs / 1000));
      const seconds = total % 60;
      const minutes = Math.floor(total / 60) % 60;
      const hours = Math.floor(total / 3600);
      if (hours > 0) return t('duration.hours', { hours, minutes });
      if (minutes > 0) return t('duration.minutes', { minutes, seconds });
      return t('duration.seconds', { seconds });
    }

    function formatBytes(bytes) {
      if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
      if (bytes >= 1024) {
        const kb = bytes / 1024;
        // 1023.95 KB would round to '1024.0 KB'; promote it instead.
        return kb >= 1023.95 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${kb.toFixed(1)} KB`;
      }
      return `${bytes} B`;
    }

    /** Drop ANSI SGR/CSI sequences before rendering raw process text. */
    function stripAnsi(text) {
      return text.indexOf('\u001b') === -1 ? text : text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '');
    }

    /** Keep the newest characters for rendering without splitting a surrogate pair. */
    function tailSlice(text, limit) {
      if (text.length <= limit) return { text, clipped: false };
      let cut = text.length - limit;
      const unit = text.charCodeAt(cut);
      if (unit >= 0xdc00 && unit <= 0xdfff) cut += 1;
      return { text: text.slice(cut), clipped: true };
    }

    /** Learned durations per command label, used to estimate silent jobs. */
    const DURATION_KEY = 'dsh-job-monitor:durations';
    const DURATION_SAMPLES = 5;
    const DURATION_LABELS = 200;
    const durationCache = new Map();
    let durationsLoaded = false;

    function loadDurations() {
      if (durationsLoaded) return;
      durationsLoaded = true;
      try {
        const parsed = JSON.parse(window.localStorage.getItem(DURATION_KEY) ?? '{}');
        for (const [label, samples] of Object.entries(parsed)) {
          if (Array.isArray(samples)) {
            durationCache.set(label, samples.filter((value) => typeof value === 'number').slice(-DURATION_SAMPLES));
          }
        }
      } catch {
        /* a corrupt store only costs the estimate */
      }
    }

    function persistDurations() {
      try {
        const plain = {};
        for (const [label, samples] of durationCache) plain[label] = samples;
        window.localStorage.setItem(DURATION_KEY, JSON.stringify(plain));
      } catch {
        /* storage may be unavailable; estimates fall back to the default */
      }
    }

    /** Median observed duration for one command label, if any run finished. */
    function expectedDuration(label) {
      loadDurations();
      const samples = durationCache.get(label);
      if (samples === undefined || samples.length === 0) return undefined;
      const sorted = [...samples].sort((left, right) => left - right);
      return sorted[Math.floor(sorted.length / 2)];
    }

    /** Remember one settled run so the next one can estimate. */
    function rememberDuration(label, elapsedMs) {
      if (elapsedMs <= 0) return;
      loadDurations();
      const samples = durationCache.get(label) ?? [];
      samples.push(elapsedMs);
      while (samples.length > DURATION_SAMPLES) samples.shift();
      durationCache.delete(label);
      durationCache.set(label, samples);
      while (durationCache.size > DURATION_LABELS) {
        durationCache.delete(durationCache.keys().next().value);
      }
      persistDurations();
    }

    /**
     * Elapsed time as a fraction of the expected run. Below the expectation it is
     * linear, so the bar moves predictably; once overdue it keeps creeping
     * towards (but never reaching) the end, so a slow job never looks frozen at a
     * hard cap and the final jump stays small.
     */
    function estimateRatio(elapsedMs, expectedMs) {
      const total = Math.max(1000, expectedMs);
      const elapsed = Math.max(0, elapsedMs);
      if (elapsed <= total) return Math.min(0.95, elapsed / total);
      return Math.min(0.99, 0.95 + 0.04 * (1 - Math.exp(-(elapsed - total) / total)));
    }

    /** Order used by the purpose grouping and its headers. */
    const PURPOSE_ORDER = ['download', 'install', 'build', 'test', 'serve', 'archive', 'search', 'cleanup', 'git', 'other'];

    /**
     * Command shapes that name the job's intent. First match wins, so the list is
     * ordered from the most specific intent to the broadest: an `npm install`
     * that also removes a cache is still an install.
     */
    const PURPOSE_RULES = [
      ['install', /(?:^|[\s;&|])(?:npm|pnpm|yarn|bun|pip3?|pipx|apt|apt-get|brew|winget|choco|cargo|gem|composer|poetry|uv|go)\s+(?:install|add|i|ci|sync|get)\b/i],
      ['build', /(?:^|[\s;&|])(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?build\b|\b(?:tsc|vite\s+build|webpack|rollup|esbuild|make|cmake|cargo\s+build|gradle|mvn|msbuild|dotnet\s+build)\b/i],
      ['test', /(?:^|[\s;&|])(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b|\b(?:pytest|jest|vitest|mocha|playwright|cypress|go\s+test|cargo\s+test|dotnet\s+test)\b/i],
      ['download', /\b(?:curl|wget|aria2c|invoke-webrequest|iwr|start-bitstransfer|scp|rsync|git\s+clone|git\s+fetch|pip\s+download|npm\s+pack)\b/i],
      ['archive', /\b(?:tar|zip|unzip|7z|gzip|gunzip|xz|rar)\b/i],
      ['cleanup', /\b(?:rm|rmdir|del|erase|pkill|kill|taskkill|truncate|prune|unlink|shred)\b|\bgit\s+clean\b/i],
      ['serve', /\b(?:http\.server|vite|next\s+dev|nodemon|uvicorn|gunicorn|flask\s+run|serve|watch)\b/i],
      ['search', /\b(?:rg|grep|ag|ack|fd|find|whereis)\b/i],
      ['git', /\bgit\b/i],
    ];

    const purposeCache = new Map();

    /**
     * The job's intent, read from its command text. Heuristic by nature: it only
     * names what the command says, so an exotic command falls back to "other"
     * instead of guessing.
     *
     * @param job - roster row.
     * @returns one of PURPOSE_ORDER.
     */
    function purposeOf(job) {
      const text = String(job?.label ?? '');
      const cached = purposeCache.get(text);
      if (cached !== undefined) return cached;
      let found = 'other';
      for (const [id, rule] of PURPOSE_RULES) {
        if (rule.test(text)) {
          found = id;
          break;
        }
      }
      if (purposeCache.size > 500) purposeCache.clear();
      purposeCache.set(text, found);
      return found;
    }

    /** Wall-clock time of one timestamp, for tooltips. */
    function clockTime(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '';
      const date = new Date(value);
      const pad = (part) => String(part).padStart(2, '0');
      return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
    }

    /** The session the main view currently retains. */
    function selectCurrentSession(state) {
      for (const session of Object.values(state.byId)) {
        if ((session.retainedBy?.mainView ?? 0) > 0) return session.id;
      }
      return undefined;
    }

    function readStored(key, fallback) {
      try {
        const value = window.localStorage.getItem(key);
        return value === null ? fallback : value;
      } catch {
        return fallback;
      }
    }

    function writeStored(key, value) {
      try {
        window.localStorage.setItem(key, value);
      } catch {
        /* storage may be unavailable; the page still works for this life */
      }
    }

    function useJobsSnapshot(store) {
      const subscribe = React.useCallback((onChange) => store.subscribe(onChange), [store]);
      const read = React.useCallback(() => store.getSnapshot(), [store]);
      return React.useSyncExternalStore(subscribe, read, read);
    }

    /** One job's observed output, subscribed per pane. */
    function useObserved(store, jobId) {
      const subscribe = React.useCallback(
        (onChange) => (jobId === undefined ? () => {} : store.subscribe(onChange)),
        [store, jobId],
      );
      const read = React.useCallback(
        () => (jobId === undefined ? undefined : store.getSnapshot().observed[jobId]),
        [store, jobId],
      );
      return React.useSyncExternalStore(subscribe, read, read);
    }

    function StopGlyph() {
      return h(
        'svg',
        { viewBox: '0 0 12 12', width: 9, height: 9, 'aria-hidden': true },
        h('rect', { x: 1.5, y: 1.5, width: 9, height: 9, rx: 2, fill: 'currentColor' }),
      );
    }

    /** Sidebar entry icon; the shell wraps it in the panel button. */
    function PanelIcon({ size }) {
      const edge = typeof size === 'number' && size > 0 ? size : 18;
      return h(
        'svg',
        {
          viewBox: '0 0 20 20',
          width: edge,
          height: edge,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinecap: 'round',
          'aria-hidden': true,
        },
        h('rect', { x: 2.5, y: 3.5, width: 15, height: 13, rx: 3 }),
        h('path', { d: 'M5.5 7.5h3M5.5 10.5h6M5.5 13.5h4' }),
        h('circle', { cx: 14.6, cy: 7.4, r: 1.4, fill: 'currentColor', stroke: 'none' }),
      );
    }

    /** A render error inside the page degrades to a retry affordance. */
    class Boundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { error: undefined };
        this.reset = () => this.setState({ error: undefined });
      }

      static getDerivedStateFromError(error) {
        return { error };
      }

      componentDidCatch(error) {
        window.console?.error?.('dsh-job-monitor:', error);
      }

      componentDidUpdate(previous) {
        if (this.state.error !== undefined && previous.resetKey !== this.props.resetKey) this.reset();
      }

      render() {
        if (this.state.error === undefined) return this.props.children;
        return this.props.fallback(this.state.error, this.reset);
      }
    }

    /** Stand-in for the page when its own render fails. */
    function CrashFace({ t, error, onRetry }) {
      const [copied, setCopied] = React.useState(false);
      const shown = React.useMemo(() => {
        if (find === '' || !onlyMatches) return text;
        const needle = find.toLowerCase();
        return text
          .split(String.fromCharCode(10))
          .filter((line) => line.toLowerCase().includes(needle))
          .join(String.fromCharCode(10));
      }, [text, find, onlyMatches]);

      const nodes = React.useMemo(() => {
        if (find === '' || shown === '') return shown;
        const needle = find.toLowerCase();
        const lower = shown.toLowerCase();
        const parts = [];
        let index = 0;
        let hits = 0;
        while (hits < 400) {
          const at = lower.indexOf(needle, index);
          if (at < 0) break;
          if (at > index) parts.push(shown.slice(index, at));
          parts.push(h('mark', { key: `hit-${at}`, className: 'jp-hit' }, shown.slice(at, at + needle.length)));
          index = at + needle.length;
          hits += 1;
        }
        if (index < shown.length) parts.push(shown.slice(index));
        return parts;
      }, [shown, find]);

      const hits = React.useMemo(() => {
        if (find === '') return 0;
        const needle = find.toLowerCase();
        const lower = shown.toLowerCase();
        let count = 0;
        let index = 0;
        while (count < 400) {
          const at = lower.indexOf(needle, index);
          if (at < 0) break;
          count += 1;
          index = at + needle.length;
        }
        return count;
      }, [shown, find]);

      const copy = () => {
        const detail = String(error?.stack ?? error?.message ?? error ?? '');
        const clipboard = window.navigator?.clipboard;
        if (clipboard?.writeText !== undefined) {
          clipboard.writeText(detail).then(
            () => setCopied(true),
            () => undefined,
          );
        }
      };
      return h(
        'div',
        { className: 'jp-page' },
        h(
          'div',
          { className: 'jp-crash', role: 'status' },
          h('span', { className: 'jp-dot jp-dot-failed', 'aria-hidden': true }),
          h('span', null, t('crash.title')),
          h('button', { type: 'button', className: 'jp-btn', onClick: copy }, copied ? t('crash.copied') : t('crash.copy')),
          h('button', { type: 'button', className: 'jp-btn', onClick: onRetry }, t('crash.retry')),
        ),
        error === undefined
          ? null
          : h('pre', { className: 'jp-crash-detail' }, String(error?.stack ?? error?.message ?? error)),
      );
    }

    /**
     * The selected job's live output plus its action bar: follows the tail while
     * the reader stays at the bottom, offers a jump-back control once they scroll
     * up.
     */
    function OutputPane({ job, store, t, kill, onStop, onCopyCommand }) {
      const view = useObserved(store, String(job.id));
      const preRef = React.useRef(null);
      const timerRef = React.useRef(undefined);
      const [following, setFollowing] = React.useState(true);
      const [copied, setCopied] = React.useState(false);
      const [find, setFind] = React.useState('');
      const [onlyMatches, setOnlyMatches] = React.useState(false);
      const full = React.useMemo(() => stripAnsi(view?.text ?? ''), [view]);
      const { text, clipped } = React.useMemo(() => tailSlice(full, RENDER_TAIL), [full]);

      React.useEffect(() => {
        const element = preRef.current;
        if (element !== null && following) element.scrollTop = element.scrollHeight;
      }, [text, following]);

      React.useEffect(
        () => () => {
          if (timerRef.current !== undefined) window.clearTimeout(timerRef.current);
        },
        [],
      );

      const onScroll = (event) => {
        const element = event.currentTarget;
        setFollowing(element.scrollHeight - element.scrollTop - element.clientHeight < 24);
      };

      const jump = () => {
        const element = preRef.current;
        setFollowing(true);
        if (element !== null) element.scrollTop = element.scrollHeight;
      };

      const download = () => {
        if (full === '') return;
        const blob = new Blob([full], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = `${String(job.id)}.log`;
        anchor.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 0);
      };

      const copy = () => {
        const clipboard = window.navigator?.clipboard;
        if (clipboard?.writeText === undefined) return;
        clipboard.writeText(full).then(
          () => {
            setCopied(true);
            timerRef.current = window.setTimeout(() => setCopied(false), 1500);
          },
          () => {
            /* a denied clipboard leaves the text selectable in place */
          },
        );
      };

      return h(
        React.Fragment,
        null,
        h(
          'div',
          { className: 'jp-console' },
          view?.gapBefore === true ? h('div', { className: 'jp-notice' }, t('output.gap')) : null,
          view?.error !== undefined
            ? h('div', { className: 'jp-notice jp-notice-error' }, t('output.error', { error: view.error }))
            : null,
          clipped ? h('div', { className: 'jp-notice' }, t('output.clipped')) : null,
          h(
            'div',
            { className: 'jp-find' },
            h('input', {
              type: 'search',
              value: find,
              placeholder: t('find.placeholder'),
              'aria-label': t('find.placeholder'),
              onChange: (event) => setFind(event.target.value),
            }),
            h(
              'button',
              {
                type: 'button',
                className: 'jp-chip',
                'aria-pressed': onlyMatches,
                onClick: () => setOnlyMatches((current) => !current),
              },
              t('find.only'),
            ),
            find === ''
              ? null
              : h('span', { className: 'jp-meta' }, t('find.matches', { count: hits })),
          ),
          h(
            'pre',
            {
              ref: preRef,
              className: text === '' ? 'jp-pre jp-pre-empty' : 'jp-pre',
              onScroll,
              'aria-label': t('output.aria', { label: job.label }),
            },
            text === '' ? t('output.empty') : nodes,
          ),
          following ? null : h('button', { type: 'button', className: 'jp-jump', onClick: jump }, t('console.jump')),
        ),
        h(
          'div',
          { className: 'jp-actions' },
          h('span', { className: 'jp-meta' }, t('output.bytes', { bytes: formatBytes(job.output?.total ?? 0) })),
          h('span', { className: 'jp-spacer' }),
          h('button', { type: 'button', className: 'jp-btn', onClick: onCopyCommand }, t('action.copyCommand')),
          h('button', { type: 'button', className: 'jp-btn', onClick: copy, disabled: text === '' }, copied ? t('output.copied') : t('output.copy')),
          h('button', { type: 'button', className: 'jp-btn', onClick: download, disabled: text === '' }, t('output.download')),
          isLive(job)
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'jp-btn jp-btn-primary',
                  disabled: kill?.phase === 'pending',
                  onClick: onStop,
                },
                kill?.phase === 'armed' ? t('kill.stopAction') : t('action.stop'),
              )
            : null,
        ),
      );
    }

    /**
     * The number a bar can show, in order of honesty: a percentage the producer
     * reported, one read off the newest output line, then a time-based estimate
     * for a silent job. Every non-measured value is rendered with a leading ≈.
     */
    function useProgress(job, store, now) {
      const held = React.useRef({ id: undefined, value: undefined });
      const meterRef = React.useRef({ id: undefined, since: 0, sinceRatio: 0, total: 0, seenAt: 0 });
      const live = job !== undefined && isLive(job);
      const measured = job === undefined ? undefined : progressOf(job);
      const view = useObserved(store, live && measured === undefined ? String(job.id) : undefined);
      const inferred = React.useMemo(
        () => (view === undefined ? undefined : progressFromOutput(stripAnsi(view.text ?? ''))),
        [view],
      );
      const estimated = React.useMemo(() => {
        if (!live || measured !== undefined || inferred !== undefined) return undefined;
        const expected = expectedDuration(job.label) ?? 120000;
        const ratio = estimateRatio(now - job.startedAt, expected);
        return { ratio, label: `${Math.round(ratio * 100)}%` };
      }, [live, measured, inferred, now, job]);
      let chosen;
      let kind = 'none';
      if (measured !== undefined) {
        chosen = measured;
        kind = 'measured';
      } else if (inferred !== undefined) {
        chosen = inferred;
        kind = 'inferred';
      } else if (estimated !== undefined) {
        chosen = estimated;
        kind = 'estimated';
      }

      // A job's bar only moves forward while it runs: a meter that scrolls out of
      // the parse window (or a log line that swallows it) must not make the
      // number fall back to an older value.
      const id = job === undefined ? undefined : String(job.id);
      if (live && chosen !== undefined) {
        if (held.current.id !== id) held.current = { id, value: chosen };
        else if (held.current.value !== undefined && chosen.ratio + 1e-9 < held.current.value.ratio) {
          chosen = held.current.value;
        } else {
          held.current.value = chosen;
        }
      }

      // Rolling rate over a short window, turned into a remaining time. Estimates
      // are excluded because they are already derived from elapsed time.
      const meter = meterRef.current;
      let etaMs;
      if (live && chosen !== undefined) {
        if (meter.id !== id) {
          meterRef.current = { id, since: now, sinceRatio: chosen.ratio, total: job.output?.total ?? 0, seenAt: now };
        } else {
          if (now - meter.since >= RATE_WINDOW_MS) {
            meter.since = now;
            meter.sinceRatio = chosen.ratio;
          }
          if (now - meter.since > 0 && kind !== 'estimated' && chosen.ratio > 0 && chosen.ratio < 1) {
            const rate = (chosen.ratio - meter.sinceRatio) / (now - meter.since);
            if (rate > 1e-7) etaMs = (1 - chosen.ratio) / rate;
          }
          const total = job.output?.total ?? 0;
          if (total !== meter.total) {
            meter.total = total;
            meter.seenAt = now;
          }
        }
      }

      const stalled =
        live &&
        meterRef.current.id === id &&
        now - meterRef.current.seenAt > STALL_MS &&
        now - job.startedAt > STALL_MS;

      return { progress: chosen, kind, etaMs, stalled };
    }

    /** One row in the task table. */
    const Row = React.memo(function Row({ job, store, sessionTitle, selected, now, killPhase, pinned, onTogglePin, onSelect, onPressKill, onOpenSession, t }) {
      const live = isLive(job);
      const { progress, kind, etaMs, stalled } = useProgress(job, store, now);
      const outcome = abnormalOf(job);
      const duration = formatDuration(
        live ? now - job.startedAt : (job.finishedAt ?? job.startedAt) - job.startedAt,
        t,
      );
      const fillClass = !live
        ? outcome === 'failed'
          ? 'jp-fill jp-fill-failed'
          : outcome === 'nonzero'
            ? 'jp-fill jp-fill-warn'
            : 'jp-fill jp-fill-done'
        : 'jp-fill';
      const indeterminate = live && progress === undefined;
      const approximate = progress !== undefined && kind !== 'measured';
      const barTitle =
        kind === 'inferred'
          ? t('progress.inferred')
          : kind === 'estimated'
            ? t('progress.estimated')
            : undefined;
      const etaLabel =
        live && etaMs !== undefined && etaMs > 1000 && etaMs < 6 * 3600 * 1000
          ? t('row.eta', { time: formatDuration(etaMs, t) })
          : undefined;
      const killTitle =
        killPhase === 'armed'
          ? t('kill.confirm')
          : killPhase === 'failed'
            ? t('kill.failed')
            : t('kill.stop', { label: job.label });

      return h(
        'div',
        {
          className: 'jp-row',
          id: `jp-opt-${String(job.id)}`,
          role: 'option',
          'aria-selected': selected,
          tabIndex: 0,
          onClick: () => onSelect(String(job.id)),
          onKeyDown: (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              onSelect(String(job.id));
            }
          },
        },
        h('span', { className: 'jp-row-main' }, [
          h('span', { key: 'dot', className: rowDotClass(job), 'aria-hidden': true }),
          h('span', { key: 'label', className: 'jp-label', title: job.label }, job.label),
          h('span', { key: 'tag', className: 'jp-tag', title: t('group.purpose') }, t(`purpose.${purposeOf(job)}`)),
          h(
            'button',
            {
              key: 'pin',
              type: 'button',
              className: pinned ? 'jp-pin jp-pin-on' : 'jp-pin',
              'aria-pressed': pinned,
              title: pinned ? t('pin.remove') : t('pin.add'),
              onClick: (event) => {
                event.stopPropagation();
                onTogglePin(String(job.id));
              },
            },
            pinned ? '★' : '☆',
          ),
          h(
            'span',
            { key: 'bar', className: indeterminate ? 'jp-bar jp-bar-indeterminate' : 'jp-bar', title: barTitle },
            h('span', {
              className: fillClass,
              style: indeterminate ? undefined : { width: live ? `${Math.round((progress?.ratio ?? 0) * 100)}%` : '100%' },
            }),
          ),
          h(
            'span',
            { key: 'barlabel', className: 'jp-bar-label' },
            progress === undefined
              ? live
                ? t('progress.live')
                : ''
              : [
                  approximate ? h('span', { key: 'ap', className: 'jp-approx' }, '≈') : null,
                  h('span', { key: 'v' }, progress.label),
                ],
          ),
          stalled
            ? h('span', { key: 'stall', className: 'jp-badge jp-badge-warn', title: t('row.stalledHint') }, t('row.stalled'))
            : null,
          etaLabel === undefined ? null : h('span', { key: 'eta', className: 'jp-meta' }, `· ${etaLabel}`),
          h('span', {
            key: 'duration',
            className: 'jp-duration',
            title: live
              ? t('time.started', { start: clockTime(job.startedAt) })
              : t('time.range', { start: clockTime(job.startedAt), end: clockTime(job.finishedAt ?? job.startedAt) }),
          }, duration),
        ]),
        h('span', { className: 'jp-line2' }, [
          h('span', { key: 'kind', className: 'jp-kind' }, job.kind),
          h('span', { key: 'status' }, t(`status.${job.status}`)),
          sessionTitle === undefined
            ? null
            : onOpenSession === undefined || job.owner === undefined
              ? h('span', { key: 'session', className: 'jp-meta', title: sessionTitle }, `· ${sessionTitle}`)
              : h(
                  'button',
                  {
                    key: 'session',
                    type: 'button',
                    className: 'jp-meta jp-session',
                    title: t('action.openSession', { title: sessionTitle }),
                    onClick: (event) => {
                      event.stopPropagation();
                      onOpenSession(job.owner);
                    },
                  },
                  `· ${sessionTitle}`,
                ),
          h('span', { key: 'spacer', className: 'jp-spacer' }),
          live
            ? h(
                'button',
                {
                  key: 'kill',
                  type: 'button',
                  className: 'jp-kill',
                  'data-kill-state': killPhase,
                  disabled: killPhase === 'pending',
                  'aria-label': killTitle,
                  title: killTitle,
                  onClick: (event) => {
                    event.stopPropagation();
                    onPressKill(job);
                  },
                },
                h(StopGlyph, { key: 'glyph' }),
                killPhase === 'armed' ? h('span', { key: 'text' }, t('kill.stopAction')) : null,
              )
            : null,
        ]),
      );
    });

    const SETTING_HISTORY = 'dsh-job-monitor:history';
    const HISTORY_LIMIT = 200;

    function loadHistory() {
      try {
        const raw = JSON.parse(readStored(SETTING_HISTORY, '[]'));
        return Array.isArray(raw) ? raw.filter((entry) => entry !== null && typeof entry.id === 'string') : [];
      } catch {
        return [];
      }
    }

    /** Append one settled job, newest first, deduplicated by id. */
    function appendHistory(list, entry) {
      if (list.some((item) => item.id === entry.id)) return list;
      const next = [entry, ...list].slice(0, HISTORY_LIMIT);
      writeStored(SETTING_HISTORY, JSON.stringify(next));
      return next;
    }

    /** Aggregates for the history view. */
    function summarizeHistory(entries) {
      const total = entries.length;
      let ok = 0;
      let abnormal = 0;
      let bytes = 0;
      let durationSum = 0;
      let durationCount = 0;
      const byCommand = new Map();
      for (const entry of entries) {
        if (entry.status === 'completed' && (entry.outcome === undefined || entry.outcome === null)) ok += 1;
        if (entry.status === 'failed' || entry.outcome === 'failed' || entry.outcome === 'nonzero') abnormal += 1;
        bytes += typeof entry.bytes === 'number' ? entry.bytes : 0;
        if (typeof entry.startedAt === 'number' && typeof entry.finishedAt === 'number') {
          const span = entry.finishedAt - entry.startedAt;
          if (span >= 0) {
            durationSum += span;
            durationCount += 1;
          }
        }
        const key = String(entry.label ?? '');
        const bucket = byCommand.get(key) ?? { label: key, count: 0, durationSum: 0, durationCount: 0 };
        bucket.count += 1;
        if (typeof entry.startedAt === 'number' && typeof entry.finishedAt === 'number') {
          const span = entry.finishedAt - entry.startedAt;
          if (span >= 0) {
            bucket.durationSum += span;
            bucket.durationCount += 1;
          }
        }
        byCommand.set(key, bucket);
      }
      const commands = [...byCommand.values()].sort((left, right) => right.count - left.count).slice(0, 6);
      const failures = entries.filter((entry) => entry.status === 'failed' || entry.outcome === 'failed' || entry.outcome === 'nonzero').slice(0, 6);
      return {
        total,
        ok,
        abnormal,
        bytes,
        averageMs: durationCount === 0 ? undefined : Math.round(durationSum / durationCount),
        commands,
        failures,
      };
    }

    /** Read-only ledger of finished jobs, kept locally. */
    function HistoryPanel({ entries, t, onClear }) {
      const summary = React.useMemo(() => summarizeHistory(entries), [entries]);
      const cell = (label, value) =>
        h('div', { className: 'jp-stat jp-stat-static' }, [
          h('span', { key: 'l', className: 'jp-stat-label' }, label),
          h('span', { key: 'v', className: 'jp-stat-value' }, value),
        ]);
      return h(
        'div',
        { className: 'jp-history' },
        h('div', { className: 'jp-stats' }, [
          cell(t('history.total'), String(summary.total)),
          cell(t('history.ok'), String(summary.ok)),
          cell(t('history.abnormal'), String(summary.abnormal)),
          cell(t('history.average'), summary.averageMs === undefined ? '—' : formatDuration(summary.averageMs, t)),
          cell(t('history.bytes'), formatBytes(summary.bytes)),
        ]),
        h(
          'div',
          { className: 'jp-history-grid' },
          h(
            'div',
            { className: 'jp-history-col' },
            h('div', { className: 'jp-history-title' }, t('history.frequent')),
            summary.commands.length === 0
              ? h('div', { className: 'jp-meta' }, t('history.empty'))
              : summary.commands.map((command) =>
                  h(
                    'div',
                    { key: command.label, className: 'jp-history-row', title: command.label },
                    h('span', { className: 'jp-history-name' }, command.label),
                    h('span', { className: 'jp-meta' }, `×${command.count}`),
                    h(
                      'span',
                      { className: 'jp-meta' },
                      command.durationCount === 0 ? '—' : formatDuration(Math.round(command.durationSum / command.durationCount), t),
                    ),
                  ),
                ),
          ),
          h(
            'div',
            { className: 'jp-history-col' },
            h('div', { className: 'jp-history-title' }, t('history.failures')),
            summary.failures.length === 0
              ? h('div', { className: 'jp-meta' }, t('history.empty'))
              : summary.failures.map((entry) =>
                  h(
                    'div',
                    { key: entry.id, className: 'jp-history-row', title: entry.label },
                    h('span', { className: 'jp-history-name' }, entry.label),
                    h('span', { className: 'jp-badge jp-badge-warn' }, entry.detail ?? entry.status),
                  ),
                ),
          ),
        ),
        h(
          'div',
          { className: 'jp-history-foot' },
          h('span', { className: 'jp-meta' }, t('history.hint')),
          h('button', { type: 'button', className: 'jp-btn', onClick: onClear }, t('history.clear')),
        ),
      );
    }

    /**
     * The page. Watches every session the client knows about (bounded), merges
     * their rosters, and renders one filterable table plus a live output pane.
     */
    function Page({ useSessions, t, jobs, openSession }) {
      const sessions = useSessions((state) => state);
      const store = jobs.state;
      const snapshot = useJobsSnapshot(store);

      const sessionIds = React.useMemo(
        () => (Array.isArray(sessions.ids) ? sessions.ids : Object.keys(sessions.byId)),
        [sessions],
      );
      const watched = React.useMemo(() => sessionIds.slice(0, watchLimit), [sessionIds, watchLimit]);

      const allJobs = React.useMemo(() => {
        const seen = new Map();
        for (const id of watched) {
          for (const job of snapshot.rows[id] ?? EMPTY) {
            const key = String(job.id);
            if (!seen.has(key)) seen.set(key, job);
          }
        }
        const sorted = sortJobs([...seen.values()]);
        if (pins.length === 0) return sorted;
        const pinnedIds = new Set(pins);
        return [
          ...sorted.filter((job) => pinnedIds.has(String(job.id))),
          ...sorted.filter((job) => !pinnedIds.has(String(job.id))),
        ];
      }, [snapshot, watched, pins]);

      const [now, setNow] = React.useState(() => Date.now());
      const [statusFilter, setStatusFilter] = React.useState(() => {
        const stored = readStored('dsh-job-monitor:filter', 'all');
        return ['all', 'live', 'done', 'abnormal'].includes(stored) ? stored : 'all';
      });
      const [watchLimit, setWatchLimit] = useNumberSetting(SETTING_WATCH, MAX_WATCH, 5, 200);
      const [observeLimit, setObserveLimit] = useNumberSetting(SETTING_OBSERVE, MAX_OBSERVE, 1, 12);
      const [settingsOpen, setSettingsOpen] = React.useState(false);
      const [density, setDensity] = React.useState(() => (readStored(SETTING_DENSITY, 'cozy') === 'compact' ? 'compact' : 'cozy'));
      const [history, setHistory] = React.useState(() => loadHistory());
      const [view, setView] = React.useState('jobs');
      const [pins, setPins] = React.useState(() => {
        try {
          const parsed = JSON.parse(readStored(SETTING_PINS, '[]'));
          return Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string') : [];
        } catch {
          return [];
        }
      });
      const [groupMode, setGroupMode] = React.useState(() => {
        const stored = readStored('dsh-job-monitor:group', 'status');
        return ['status', 'session', 'kind', 'none'].includes(stored) ? stored : 'status';
      });
      const [query, setQuery] = React.useState('');
      const [selectedId, setSelectedId] = React.useState(undefined);
      const [killState, setKillState] = React.useState(undefined);
      const [announcement, setAnnouncement] = React.useState('');
      const terminalStates = React.useRef(new Map());
      const searchRef = React.useRef(null);

      const live = React.useMemo(() => allJobs.filter(isLive), [allJobs]);
      const currentSession = useSessions(selectCurrentSession);

      // Open one roster stream per watched session; the service refcounts them.
      React.useEffect(() => {
        if (watched.length === 0) return undefined;
        const releases = watched.map((id) => jobs.watchRows(id));
        return () => {
          for (const release of releases) release();
        };
      }, [watched, jobs]);

      // One clock for every visible duration, only while something is live.
      React.useEffect(() => {
        if (live.length === 0) return undefined;
        setNow(Date.now());
        const timer = window.setInterval(() => setNow(Date.now()), 1000);
        return () => window.clearInterval(timer);
      }, [live.length]);

      const stats = React.useMemo(() => {
        const dayStart = new Date();
        dayStart.setHours(0, 0, 0, 0);
        let running = 0;
        let today = 0;
        let abnormal = 0;
        let bytes = 0;
        for (const job of allJobs) {
          bytes += job.output?.total ?? 0;
          if (isLive(job)) running += 1;
          else if ((job.finishedAt ?? 0) >= dayStart.getTime()) today += 1;
          if (abnormalOf(job) !== undefined) abnormal += 1;
        }
        return { running, today, abnormal, bytes };
      }, [allJobs]);

      const visible = React.useMemo(() => {
        const needle = query.trim().toLowerCase();
        return allJobs.filter((job) => {
          if (statusFilter === 'live' && !isLive(job)) return false;
          if (statusFilter === 'done' && (isLive(job) || abnormalOf(job) !== undefined)) return false;
          if (statusFilter === 'abnormal' && abnormalOf(job) === undefined) return false;
          if (needle === '') return true;
          const title = job.owner === undefined ? '' : (sessions.byId[job.owner]?.title ?? '');
          return `${job.label} ${job.kind} ${title}`.toLowerCase().includes(needle);
        });
      }, [allJobs, statusFilter, query, sessions]);

      const groups = React.useMemo(() => {
        if (groupMode === 'none') return [{ key: 'all', title: undefined, jobs: visible }];
        const buckets = new Map();
        for (const job of visible) {
          const key =
            groupMode === 'session'
              ? `session:${job.owner ?? ''}`
              : groupMode === 'kind'
                ? `kind:${job.kind}`
                : groupMode === 'purpose'
                  ? `purpose:${purposeOf(job)}`
                  : `status:${isLive(job) ? 'live' : abnormalOf(job) ?? 'done'}`;
          if (!buckets.has(key)) buckets.set(key, []);
          buckets.get(key).push(job);
        }
        const entries = [...buckets.entries()];
        if (groupMode === 'purpose') {
          entries.sort(
            (left, right) =>
              PURPOSE_ORDER.indexOf(left[0].replace('purpose:', '')) -
              PURPOSE_ORDER.indexOf(right[0].replace('purpose:', '')),
          );
        }
        return entries.map(([key, bucket]) => ({ key, title: key, jobs: bucket }));
      }, [visible, groupMode]);

      // Selection survives roster updates; it falls back to the busiest row.
      const selected = React.useMemo(
        () => allJobs.find((job) => String(job.id) === selectedId) ?? live[0] ?? allJobs[0],
        [allJobs, live, selectedId],
      );
      const selectedKey = selected === undefined ? undefined : String(selected.id);

      // Every running job is observed so its own meter line (curl -#, wget,
      // build tools) can fill the bar; the list stays bounded, not the roster.
      const observeKey = live
        .slice(0, observeLimit)
        .map((job) => `${String(job.id)}@${job.owner ?? currentSession ?? ''}`)
        .join('|');
      React.useEffect(() => {
        if (observeKey === '') return undefined;
        const releases = [];
        for (const entry of observeKey.split('|')) {
          const at = entry.lastIndexOf('@');
          const id = entry.slice(0, at);
          const owner = entry.slice(at + 1);
          const caller = owner === '' ? undefined : owner;
          if (id !== '' && caller !== undefined) releases.push(jobs.observe(caller, id));
        }
        return () => {
          for (const release of releases) release();
        };
      }, [observeKey, jobs]);

      // The same numbers for the detail header as for the selected row.
      const detail = useProgress(selected, store, now);

      // Announce settlements once, for readers that are not watching the table.
      React.useEffect(() => {
        const next = new Map();
        const fresh = [];
        for (const job of allJobs) {
          const key = String(job.id);
          next.set(key, job.status);
          const before = terminalStates.current.get(key);
          if (before !== undefined && before !== job.status && !isLive(job)) {
            fresh.push(`${job.label}: ${t(`status.${job.status}`)}`);
            if (typeof job.startedAt === 'number' && typeof job.finishedAt === 'number') {
              rememberDuration(job.label, job.finishedAt - job.startedAt);
            }
            setHistory((current) =>
              appendHistory(current, {
                id: String(job.id),
                label: job.label,
                purpose: purposeOf(job),
                status: job.status,
                outcome: abnormalOf(job) ?? null,
                startedAt: job.startedAt,
                finishedAt: job.finishedAt ?? Date.now(),
                bytes: job.output?.total ?? 0,
                detail: job.detail,
                owner: job.owner,
              }),
            );
          }
        }
        terminalStates.current = next;
        if (fresh.length > 0) setAnnouncement(fresh.join('; '));
      }, [allJobs, t]);

      // Every stop phase resets itself.
      React.useEffect(() => {
        if (killState === undefined) return undefined;
        const delay =
          killState.phase === 'armed'
            ? KILL_ARM_MS
            : killState.phase === 'failed'
              ? KILL_FAILED_MS
              : KILL_PENDING_MS;
        const timer = window.setTimeout(() => setKillState(undefined), delay);
        return () => window.clearTimeout(timer);
      }, [killState]);

      React.useEffect(() => {
        if (killState !== undefined && !allJobs.some((job) => String(job.id) === killState.id && isLive(job))) {
          setKillState(undefined);
        }
      }, [allJobs, killState]);

      const selectRow = React.useCallback((id) => setSelectedId(id), []);

      const togglePin = React.useCallback((id) => {
        setPins((current) => {
          const next = current.includes(id) ? current.filter((value) => value !== id) : [...current, id];
          writeStored(SETTING_PINS, JSON.stringify(next));
          return next;
        });
      }, []);

      const exportReport = React.useCallback(() => {
        const rows = [t('export.heading'), ''];
        for (const job of allJobs) {
          rows.push(`## ${job.label}`);
          rows.push(`- ${t('export.status')}: ${t(`status.${job.status}`)}`);
          rows.push(`- ${t('export.purpose')}: ${t(`purpose.${purposeOf(job)}`)}`);
          rows.push(`- ${t('export.duration')}: ${formatDuration((job.finishedAt ?? Date.now()) - job.startedAt, t)}`);
          rows.push(`- ${t('export.output')}: ${formatBytes(job.output?.total ?? 0)}`);
          rows.push(`- ${t('export.started')}: ${clockTime(job.startedAt)}`);
          if (job.detail !== undefined) rows.push(`- ${t('export.detail')}: ${job.detail}`);
          rows.push('');
        }
        const blob = new Blob([rows.join(String.fromCharCode(10))], { type: 'text/markdown;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = 'job-report.md';
        anchor.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 0);
      }, [allJobs, t]);

      const toggleDensity = React.useCallback(() => {
        setDensity((current) => {
          const next = current === 'compact' ? 'cozy' : 'compact';
          writeStored(SETTING_DENSITY, next);
          return next;
        });
      }, []);

      // Stable identity so memoized rows are not invalidated by unrelated renders.
      const pressKill = React.useCallback((job) => {
        const key = String(job.id);
        if (killState === undefined || killState.id !== key || killState.phase !== 'armed') {
          setKillState({ id: key, phase: 'armed' });
          return;
        }
        setKillState({ id: key, phase: 'pending' });
        const caller = job.owner ?? currentSession;
        if (caller === undefined) return;
        Promise.resolve(jobs.kill(caller, job.id)).then(
          (result) => {
            if (result?.ok === false) setKillState({ id: key, phase: 'failed' });
          },
          () => setKillState({ id: key, phase: 'failed' }),
        );
      }, [killState, jobs, currentSession]);

      const setFilter = (value) => {
        setStatusFilter(value);
        writeStored('dsh-job-monitor:filter', value);
      };
      const setGroup = (value) => {
        setGroupMode(value);
        writeStored('dsh-job-monitor:group', value);
      };

      const move = (delta) => {
        if (visible.length === 0) return;
        const index = visible.findIndex((job) => String(job.id) === selectedKey);
        const next = visible[Math.min(visible.length - 1, Math.max(0, (index === -1 ? 0 : index) + delta))];
        if (next !== undefined) setSelectedId(String(next.id));
      };

      const copyCommand = () => {
        const clipboard = window.navigator?.clipboard;
        if (clipboard?.writeText === undefined || selected === undefined) return;
        clipboard.writeText(selected.label).catch(() => {});
      };

      const sessionTitleOf = (job) =>
        job.owner === undefined ? undefined : (sessions.byId[job.owner]?.title ?? job.owner);

      const groupTitle = (group) => {
        if (group.title === undefined) return undefined;
        if (groupMode === 'status') {
          const key = group.title.replace('status:', '');
          if (key === 'live') return t('section.live');
          if (key === 'failed') return t('status.failed');
          if (key === 'nonzero') return t('section.nonzero');
          return t('section.settled');
        }
        if (groupMode === 'kind') return group.title.replace('kind:', '');
        if (groupMode === 'purpose') return t(`purpose.${group.title.replace('purpose:', '')}`);
        const owner = group.title.replace('session:', '');
        return owner === '' ? t('section.unowned') : (sessions.byId[owner]?.title ?? owner);
      };

      const body =
        allJobs.length === 0
          ? h(
              'div',
              { className: 'jp-empty' },
              h('div', { className: 'jp-empty-title' }, t('empty.title')),
              h('div', { className: 'jp-empty-hint' }, t('empty.hint')),
            )
          : visible.length === 0
            ? h('div', { className: 'jp-empty' }, h('div', { className: 'jp-empty-title' }, t('empty.filtered')))
            : groups.map((group) =>
                h(
                  'div',
                  { key: group.key },
                  groupMode === 'none'
                    ? null
                    : h('div', { className: 'jp-section' }, [
                        h('span', { key: 't' }, groupTitle(group)),
                        h('span', { key: 'n', className: 'jp-sepdot' }, String(group.jobs.length)),
                      ]),
                  group.jobs.map((job) =>
                    h(Row, {
                      key: String(job.id),
                      job,
                      store,
                      sessionTitle: sessionTitleOf(job),
                      onOpenSession: openSession,
                      selected: String(job.id) === selectedKey,
                      now,
                      killPhase: killState?.id === String(job.id) ? killState.phase : 'idle',
                      pinned: pins.includes(String(job.id)),
                      onTogglePin: togglePin,
                      onSelect: selectRow,
                      onPressKill: pressKill,
                      t,
                    }),
                  ),
                ),
              );

      const overall = React.useMemo(() => {
        const meters = live.map((job) => progressOf(job)).filter((value) => value !== undefined);
        if (meters.length < 2) return undefined;
        const sum = meters.reduce((total, value) => total + value.ratio, 0);
        return Math.round((sum / meters.length) * 100);
      }, [live]);

      return h(
        'div',
        {
          className: density === 'compact' ? 'jp-page jp-compact' : 'jp-page',
          onKeyDown: (event) => {
            const target = event.target;
            const typing =
              target instanceof HTMLElement && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA');
            if (event.key === '/' && !typing) {
              event.preventDefault();
              searchRef.current?.focus();
              return;
            }
            if (typing) return;
            if (event.key === 'Escape') {
              event.preventDefault();
              setSelectedId(undefined);
              return;
            }
            if (event.key === 'g' || event.key === 'G') {
              const target = event.key === 'g' ? visible[0] : visible[visible.length - 1];
              if (target !== undefined) {
                event.preventDefault();
                setSelectedId(String(target.id));
              }
              return;
            }
            if (selected === undefined) return;
            if (event.key === 'x') {
              event.preventDefault();
              pressKill(selected);
              return;
            }
            if (event.key === 'r') {
              event.preventDefault();
              copyCommand();
            }
          },
        },
        h('span', { className: 'jp-sr', role: 'status', 'aria-live': 'polite' }, announcement),
        h(
          'header',
          { className: 'jp-head' },
          h('h1', { className: 'jp-title' }, t('page.title')),
          h('span', { className: 'jp-sub' }, t('page.watched', { count: watched.length, total: sessionIds.length })),
          overall === undefined ? null : h('span', { className: 'jp-sub' }, `· ${t('page.overall', { percent: overall })}`),
          h(
            'div',
            { className: 'jp-toolbar' },
            h('input', {
              ref: searchRef,
              className: 'jp-search',
              type: 'search',
              value: query,
              placeholder: t('search.placeholder'),
              'aria-label': t('search.placeholder'),
              onChange: (event) => setQuery(event.target.value),
            }),
            h(
              'button',
              {
                type: 'button',
                className: 'jp-chip jp-gear',
                'aria-pressed': view === 'history',
                title: t('history.title'),
                onClick: () => setView((current) => (current === 'history' ? 'jobs' : 'history')),
              },
              view === 'history' ? t('history.jobs') : t('history.title'),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'jp-chip jp-gear',
                title: t('export.button'),
                onClick: exportReport,
              },
              t('export.button'),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'jp-chip jp-gear',
                'aria-pressed': density === 'compact',
                title: t('density.title'),
                onClick: toggleDensity,
              },
              density === 'compact' ? t('density.cozy') : t('density.compact'),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'jp-chip jp-gear',
                'aria-expanded': settingsOpen,
                'aria-label': t('settings.title'),
                title: t('settings.title'),
                onClick: () => setSettingsOpen((open) => !open),
              },
              t('settings.label'),
            ),
          ),
        ),
        settingsOpen
          ? h(
              'div',
              { className: 'jp-settings' },
              h(
                'label',
                { className: 'jp-setting' },
                h('span', null, t('settings.watch')),
                h('input', {
                  type: 'number',
                  min: 5,
                  max: 200,
                  value: watchLimit,
                  onChange: (event) => setWatchLimit(event.target.value),
                }),
              ),
              h(
                'label',
                { className: 'jp-setting' },
                h('span', null, t('settings.observe')),
                h('input', {
                  type: 'number',
                  min: 1,
                  max: 12,
                  value: observeLimit,
                  onChange: (event) => setObserveLimit(event.target.value),
                }),
              ),
              h('span', { className: 'jp-setting-hint' }, t('settings.hint', { watch: watchLimit, observe: observeLimit })),
            )
          : null,
        view === 'history'
          ? null
          : h(
          'div',
          { className: 'jp-stats' },
          h(
            'button',
            {
              type: 'button',
              className: 'jp-stat',
              'aria-pressed': statusFilter === 'live',
              onClick: () => setFilter(statusFilter === 'live' ? 'all' : 'live'),
            },
            h('span', { className: 'jp-stat-label' }, t('stat.running')),
            h('span', { className: 'jp-stat-value' }, String(stats.running)),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'jp-stat',
              'aria-pressed': statusFilter === 'done',
              onClick: () => setFilter(statusFilter === 'done' ? 'all' : 'done'),
            },
            h('span', { className: 'jp-stat-label' }, t('stat.today')),
            h('span', { className: 'jp-stat-value' }, String(stats.today)),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'jp-stat',
              'aria-pressed': statusFilter === 'abnormal',
              onClick: () => setFilter(statusFilter === 'abnormal' ? 'all' : 'abnormal'),
            },
            h('span', { className: 'jp-stat-label' }, t('stat.abnormal')),
            h('span', { className: 'jp-stat-value' }, String(stats.abnormal)),
          ),
          h(
            'div',
            { className: 'jp-stat jp-stat-static' },
            h('span', { className: 'jp-stat-label' }, t('stat.output')),
            h('span', { className: 'jp-stat-value' }, formatBytes(stats.bytes)),
          ),
        ),
        view === 'history'
          ? null
          : h(
          'div',
          { className: 'jp-filters' },
          h(
            'div',
            { className: 'jp-chips', role: 'group', 'aria-label': t('filter.aria') },
            ...[
              ['all', t('filter.all')],
              ['live', t('filter.live')],
              ['done', t('filter.done')],
              ['abnormal', t('filter.abnormal')],
            ].map(([value, label]) =>
              h(
                'button',
                {
                  key: value,
                  type: 'button',
                  className: 'jp-chip',
                  'aria-pressed': statusFilter === value,
                  onClick: () => setFilter(value),
                },
                label,
              ),
            ),
          ),
          h(
            'div',
            { className: 'jp-group' },
            h('span', null, t('group.label')),
            ...[
              ['status', t('group.status')],
              ['purpose', t('group.purpose')],
              ['session', t('group.session')],
              ['kind', t('group.kind')],
              ['none', t('group.none')],
            ].map(([value, label]) =>
              h(
                'button',
                {
                  key: value,
                  type: 'button',
                  className: 'jp-chip',
                  'aria-pressed': groupMode === value,
                  onClick: () => setGroup(value),
                },
                label,
              ),
            ),
          ),
        ),
        h(
          'div',
          { className: 'jp-body' },
          view === 'history'
            ? h(HistoryPanel, {
                entries: history,
                t,
                onClear: () => {
                  writeStored(SETTING_HISTORY, '[]');
                  setHistory([]);
                },
              })
            : h(
            'section',
            { className: 'jp-pane' },
            h('div', { className: 'jp-pane-head' }, h('span', null, t('list.title', { count: visible.length }))),
            h(
              'div',
              {
                className: 'jp-list',
                role: 'listbox',
                'aria-label': t('list.aria'),
                'aria-activedescendant': selectedKey === undefined ? undefined : `jp-opt-${selectedKey}`,
                tabIndex: 0,
                onKeyDown: (event) => {
                  if (event.key === 'ArrowDown' || event.key === 'j') {
                    event.preventDefault();
                    move(1);
                  } else if (event.key === 'ArrowUp' || event.key === 'k') {
                    event.preventDefault();
                    move(-1);
                  }
                },
              },
              body,
            ),
          ),
          h(
            'section',
            { className: 'jp-pane jp-detail' },
            selected === undefined
              ? h('div', { className: 'jp-empty' }, h('div', { className: 'jp-empty-title' }, t('detail.empty')))
              : h(
                  React.Fragment,
                  null,
                  h(
                    'div',
                    { className: 'jp-detail-head' },
                    h(
                      'div',
                      { className: 'jp-detail-title' },
                      h('span', { className: rowDotClass(selected), 'aria-hidden': true }),
                      h('span', { className: 'jp-label', title: selected.label }, selected.label),
                      h(
                        'span',
                        { className: 'jp-duration' },
                        formatDuration(
                          isLive(selected)
                            ? now - selected.startedAt
                            : (selected.finishedAt ?? selected.startedAt) - selected.startedAt,
                          t,
                        ),
                      ),
                    ),
                    h(
                      'div',
                      { className: 'jp-detail-facts' },
                      [
                        t(`purpose.${purposeOf(selected)}`),
                        selected.kind,
                        t(`status.${selected.status}`),
                        sessionTitleOf(selected) ?? t('detail.unowned'),
                        selected.detail ?? '',
                        detail.progress === undefined
                          ? ''
                          : `${detail.kind === 'measured' ? '' : '≈'}${detail.progress.label}`,
                      ]
                        .filter(Boolean)
                        .join(' · '),
                    ),
                  ),
                  isObservable(selected)
                    ? h(OutputPane, {
                        job: selected,
                        store,
                        t,
                        kill:
                          killState?.id === selectedKey
                            ? { phase: killState.phase }
                            : { phase: 'idle' },
                        onStop: () => pressKill(selected),
                        onCopyCommand: copyCommand,
                      })
                    : h(
                        'div',
                        { className: 'jp-empty' },
                        h('div', { className: 'jp-empty-title' }, t('detail.noOutput')),
                      ),
                ),
          ),
        ),
      );
    }

    /** Simplified Chinese dictionary (the key-set source of truth). */
    const zh = {
      'page.title': '后台任务',
      'page.watched': '正在监视 {count} / {total} 个会话',
      'search.placeholder': '搜索任务、类型或会话',
      'stat.running': '运行中',
      'stat.today': '今日完成',
      'stat.abnormal': '异常',
      'stat.output': '总输出',
      'filter.aria': '按状态筛选',
      'filter.all': '全部',
      'filter.live': '运行中',
      'filter.done': '已完成',
      'filter.abnormal': '异常',
      'group.label': '分组',
      'history.title': '历史',
      'history.jobs': '任务',
      'history.total': '累计',
      'history.ok': '成功',
      'history.abnormal': '异常',
      'history.average': '平均耗时',
      'history.bytes': '总输出',
      'history.frequent': '最常跑的命令',
      'history.failures': '最近的异常',
      'history.empty': '还没有记录',
      'history.hint': '只记录本机已结束的任务（最多 200 条），存在浏览器本地。',
      'history.clear': '清空历史',
      'export.button': '导出报告',
      'export.heading': '# 后台任务报告',
      'export.status': '状态',
      'export.purpose': '用途',
      'export.duration': '耗时',
      'export.output': '输出',
      'export.started': '开始',
      'export.detail': '详情',
      'find.placeholder': '在输出里搜索',
      'find.only': '只看匹配行',
      'find.matches': '{count} 处匹配',
      'pin.add': '置顶',
      'pin.remove': '取消置顶',
      'density.title': '切换行高',
      'density.compact': '紧凑',
      'density.cozy': '舒适',
      'row.eta': '剩余约 {time}',
      'row.stalled': '可能停滞',
      'row.stalledHint': '运行中但 90 秒没有新输出，可能卡住了。',
      'page.overall': '总体 {percent}%',
      'settings.title': '设置',
      'settings.label': '设置',
      'settings.watch': '监视会话上限',
      'settings.observe': '同时观测输出',
      'settings.hint': '每条会话一条数据流，每个运行中任务一条输出流。当前 {watch} / {observe}。',
      'group.status': '状态',
      'group.session': '会话',
      'group.kind': '类型',
      'group.purpose': '用途',
      'purpose.download': '下载',
      'purpose.install': '安装',
      'purpose.build': '构建',
      'purpose.test': '测试',
      'purpose.serve': '服务',
      'purpose.archive': '压缩',
      'purpose.search': '检索',
      'purpose.cleanup': '清理',
      'purpose.git': 'Git',
      'purpose.other': '其他',
      'group.none': '不分组',
      'list.title': '任务（{count}）',
      'list.aria': '后台任务列表',
      'section.live': '进行中',
      'section.settled': '已完成',
      'section.nonzero': '非零退出',
      'section.unowned': '无归属会话',
      'empty.title': '还没有后台任务',
      'empty.hint': '模型在后台运行的命令会出现在这里。也可以让我起一个，例如 `for i in 1 2 3; do echo $i; sleep 1; done`。',
      'empty.filtered': '没有符合当前筛选的任务',
      'detail.empty': '选择一个任务查看输出',
      'detail.noOutput': '这个任务没有保留输出',
      'detail.unowned': '无归属会话',
      'action.copyCommand': '复制命令',
      'action.openSession': '打开会话「{title}」',
      'action.stop': '中止',
      'progress.live': '进行中',
      'time.started': '开始于 {start}',
      'time.range': '开始 {start} · 结束 {end}',
      'progress.inferred': '从输出推断的进度',
      'progress.estimated': '按已完成耗时估算',
      'console.jump': '跳到最新',
      'crash.title': '任务页面出错了',
      'crash.retry': '重试',
      'crash.copy': '复制错误',
      'crash.copied': '已复制',
      'status.running': '运行中',
      'status.stopping': '正在停止',
      'status.completed': '已完成',
      'status.killed': '已取消',
      'status.failed': '已失败',
      'duration.seconds': '{seconds}秒',
      'duration.minutes': '{minutes}分{seconds}秒',
      'duration.hours': '{hours}小时{minutes}分',
      'kill.stop': '中止任务 {label}',
      'kill.confirm': '再次点击确认中止',
      'kill.stopAction': '确认中止',
      'kill.failed': '中止失败',
      'output.aria': '{label} 的实时输出',
      'output.gap': '……更早的输出已被丢弃……',
      'output.error': '实时输出中断：{error}',
      'output.empty': '（暂无输出）',
      'output.clipped': '……仅渲染最近的部分输出（复制仍包含完整尾部）……',
      'output.copy': '复制输出',
      'output.download': '下载 .log',
      'output.copied': '已复制',
      'output.bytes': '累计 {bytes}',
    };

    /** English dictionary, key-identical to the Chinese source of truth. */
    const en = {
      'page.title': 'Background jobs',
      'page.watched': 'Watching {count} of {total} sessions',
      'search.placeholder': 'Search jobs, kind, or session',
      'stat.running': 'Running',
      'stat.today': 'Finished today',
      'stat.abnormal': 'Abnormal',
      'stat.output': 'Output',
      'filter.aria': 'Filter by status',
      'filter.all': 'All',
      'filter.live': 'Running',
      'filter.done': 'Finished',
      'filter.abnormal': 'Abnormal',
      'group.label': 'Group',
      'history.title': 'History',
      'history.jobs': 'Jobs',
      'history.total': 'Total',
      'history.ok': 'Succeeded',
      'history.abnormal': 'Abnormal',
      'history.average': 'Average',
      'history.bytes': 'Output',
      'history.frequent': 'Most frequent commands',
      'history.failures': 'Recent failures',
      'history.empty': 'Nothing recorded yet',
      'history.hint': 'Finished jobs only, at most 200 entries, stored in this browser.',
      'history.clear': 'Clear history',
      'export.button': 'Export report',
      'export.heading': '# Background job report',
      'export.status': 'Status',
      'export.purpose': 'Purpose',
      'export.duration': 'Duration',
      'export.output': 'Output',
      'export.started': 'Started',
      'export.detail': 'Detail',
      'find.placeholder': 'Search output',
      'find.only': 'Matches only',
      'find.matches': '{count} matches',
      'pin.add': 'Pin to top',
      'pin.remove': 'Unpin',
      'density.title': 'Toggle row height',
      'density.compact': 'Compact',
      'density.cozy': 'Cozy',
      'row.eta': '{time} left',
      'row.stalled': 'stalled?',
      'row.stalledHint': 'Running but silent for 90 seconds; it may be stuck.',
      'page.overall': '{percent}% overall',
      'settings.title': 'Settings',
      'settings.label': 'Settings',
      'settings.watch': 'Session watch cap',
      'settings.observe': 'Concurrent output streams',
      'settings.hint': 'One stream per session and one per running job. Now {watch} / {observe}.',
      'group.status': 'Status',
      'group.session': 'Session',
      'group.kind': 'Kind',
      'group.purpose': 'Purpose',
      'purpose.download': 'download',
      'purpose.install': 'install',
      'purpose.build': 'build',
      'purpose.test': 'test',
      'purpose.serve': 'serve',
      'purpose.archive': 'archive',
      'purpose.search': 'search',
      'purpose.cleanup': 'cleanup',
      'purpose.git': 'git',
      'purpose.other': 'other',
      'group.none': 'None',
      'list.title': 'Jobs ({count})',
      'list.aria': 'Background job list',
      'section.live': 'Running',
      'section.settled': 'Finished',
      'section.nonzero': 'Non-zero exit',
      'section.unowned': 'No owning session',
      'empty.title': 'No background jobs yet',
      'empty.hint': 'Commands the model runs in the background show up here. Ask for one, e.g. `for i in 1 2 3; do echo $i; sleep 1; done`.',
      'empty.filtered': 'No job matches the current filter',
      'detail.empty': 'Select a job to see its output',
      'detail.noOutput': 'This job kept no output',
      'detail.unowned': 'No owning session',
      'action.copyCommand': 'Copy command',
      'action.openSession': 'Open session "{title}"',
      'action.stop': 'Stop',
      'progress.live': 'live',
      'time.started': 'started at {start}',
      'time.range': 'started {start} · ended {end}',
      'progress.inferred': 'progress inferred from output',
      'progress.estimated': 'estimated from elapsed time',
      'console.jump': 'Jump to latest',
      'crash.title': 'The jobs page hit an error',
      'crash.retry': 'Retry',
      'crash.copy': 'Copy error',
      'crash.copied': 'Copied',
      'status.running': 'running',
      'status.stopping': 'stopping',
      'status.completed': 'completed',
      'status.killed': 'cancelled',
      'status.failed': 'failed',
      'duration.seconds': '{seconds}s',
      'duration.minutes': '{minutes}m {seconds}s',
      'duration.hours': '{hours}h {minutes}m',
      'kill.stop': 'Stop job {label}',
      'kill.confirm': 'Click again to confirm',
      'kill.stopAction': 'Confirm',
      'kill.failed': 'Stop failed',
      'output.aria': 'Live output of {label}',
      'output.gap': '… earlier output was dropped …',
      'output.error': 'live output interrupted: {error}',
      'output.empty': '(no output yet)',
      'output.clipped': '… only the newest output is rendered (copy still has the full tail) …',
      'output.copy': 'Copy output',
      'output.download': 'Download .log',
      'output.copied': 'Copied',
      'output.bytes': '{bytes} total',
    };

    /** Required Client services: the shared job streams, slots, and dictionaries. */
    const inject = ['jobs', 'slots', 'locale'];

    /**
     * Client plugin body: install styles and dictionaries, register the page and
     * its sidebar entry.
     * @param ctx - Client root context.
     */
    function apply(ctx) {
      ctx.effect(() => {
        const tag = document.createElement('style');
        tag.dataset.plugin = 'dsh-job-monitor';
        tag.textContent = CSS;
        document.head.appendChild(tag);
        return () => tag.remove();
      }, 'job-monitor: styles');

      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'job-monitor: dictionaries');

      const jobs = ctx.jobs;
      const t = ctx.locale.bind(NS);
      const uiWorkspace = ctx.get('uiWorkspace');
      const openSession =
        uiWorkspace === undefined || typeof uiWorkspace.openSession !== 'function'
          ? undefined
          : (sessionId) => uiWorkspace.openSession(sessionId);
      const PageEntry = (props) =>
        h(
          Boundary,
          { fallback: (error, reset) => h(CrashFace, { t: props.t ?? t, error, onRetry: reset }) },
          h(Page, { ...props, jobs, openSession }),
        );

      ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS }, PageEntry));

      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          { name: 'sidebar.panellist', id: PANEL_ID, order: 30, locale: NS, label: () => t('page.title') },
          PanelIcon,
        ),
      );
    }

    /** Pure helpers exposed to the Node test harness only; never in a bundle. */
    const testSurface = {
      stripAnsi,
      tailSlice,
      formatDuration,
      formatBytes,
      sortJobs,
      abnormalOf,
      isLive,
      isObservable,
      selectCurrentSession,
      clampSetting,
      summarizeHistory,
      appendHistory,
      purposeOf,
      progressOf,
      progressFromOutput,
      readProgress,
      estimateRatio,
      expectedDuration,
      rememberDuration,
    };

    return {
      inject,
      apply,
      ...(globalThis.__DSH_JOB_MONITOR_TEST__ === true ? { __test: testSurface } : {}),
    };
  },
});
