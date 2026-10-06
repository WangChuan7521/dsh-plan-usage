# dsh-plan-usage

Coding-plan quota for DeepSeek Harness (DSH) profiles: every provider's usage windows on one page,
probed in the host process, rendered in the Web GUI.

```
$ node tools/usage.mjs
CommandCode · GOAT · active
  5 小时    ░░░░░░░░░░   3%  $0.37 / $14.00      · 重置 4h 43m
  周       █░░░░░░░░░  14%  $4.90 / $35.00      · 重置 2d 7h
  月       ██░░░░░░░░  16%  $11.16 / $70.00     · 重置 16d 10h
  剩余 $58.84 / 额度池 $70.00 · 本期请求 3888 · 本期消费 $11.06
  密钥来源 credential-file · user_5QByR…rUki (93)

OpenCode Go · ok
  5 小时    ░░░░░░░░░░   2%  已用 2%                · 重置 5h 12m
  周       █░░░░░░░░░  13%  已用 13%               · 重置 6d 2h
  月       █░░░░░░░░░   9%  已用 9%                · 重置 21d 4h
```

## What it does

- **CommandCode** — the rolling 5-hour and weekly caps, plus the billing period's monthly credit
  pool: dollar figures, reset countdowns, remaining credits and the period's request spend.
- **OpenCode Go** — the rolling 5-hour / weekly / monthly windows (that plan publishes
  percentages, not money).
- **Settings → 套餐用量** — one card per provider, including the credential each probe ran with.
- **Composer pill** — follows the session's selected provider, and expands upward into the full
  provider list.
- **Two loopback-only routes** — `GET /api/dsh-plan-usage/usage` and
  `POST /api/dsh-plan-usage/refresh`, plus a mirror at `$DSH_HOME/plan-usage.json`.

API keys never reach the browser: every probe runs in the host process, and the Web GUI only reads
numbers from the loopback endpoints.

## Install

```sh
DSH="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
"$DSH" plugin --profile desktop add "link:$PWD"
```

That writes the profile's `package.json` (dependency + `dsh.profile.bundles`) and links the package
into `node_modules`. **Restart DSH** afterwards: the desktop app composes its profile at launch.

## Credentials

Each provider has its own credential reference. Put the key in the harness credential file, or in an
environment variable of the same name:

```yaml
# $DSH_HOME/.credentials.yaml
refs:
  COMMANDCODE_API_KEY: user_…
  OPENCODE_GO_API_KEY: sk-…
```

### Resolution chain

The probe key is resolved in a fixed order, and **the source is reported** in the document (shown on
the card as `source · masked-key (length)`), so "which key was used" is a fact on the page rather
than an investigation:

| # | Source | Notes |
|---|---|---|
| 1 | `harness-record` | the credential DSH stores for the model route (`llm-pi-ai/<provider>`, kind `api-key`) — what the Models page writes |
| 2 | `credentials-service` | the same seam `apiKeyEnv` resolves per request |
| 3 | `env` | the reference name as an environment variable |
| 4 | `cli-env` | the provider's own CLI variable (CommandCode: `COMMAND_CODE_API_KEY`) |
| 5 | `cli-auth-file` | the provider CLI's own login file (CommandCode: `~/.commandcode/auth.json`) |
| 6 | `credential-file` | `$DSH_HOME/.credentials.yaml` → `refs` |

Requests always carry **exactly one** `Authorization: Bearer <key>`: the value is normalized first
(trimmed, and a `Bearer ` prefix already present in the stored value is stripped), so
`Bearer Bearer …` is structurally impossible. An empty key makes **no request at all** and is
reported as unconfigured.

Failures are classified (`auth` / `quota` / `rate-limit` / `not-found` / `client` / `server` /
`timeout` / `tls` / `network`) and carry the status, the provider's own error code and its sentence —
never a raw JSON blob, and never the secret. Three endpoints answering the same 401 collapse into
**one line**, owned by that provider's card.

The credential is re-resolved on every poll cycle (60 s by default), so **a new key takes effect
without a restart**.

## Configuration

The row ships in this bundle's `cordis.patch.yml`; override it in the profile's `cordis.patch.yml`
under the id `plan-usage`:

| Field | Default | Meaning |
|---|---|---|
| `pollIntervalSec` | `60` | probe cycle, 15–3600 s |
| `providers.<id>.enabled` | `true` | set `false` to skip a provider |
| `providers.<id>.apiKeyEnv` | per adapter | credential reference |
| `providers.<id>.baseUrl` | per adapter | override the endpoint origin |

Adding a provider: write a module in `lib/providers/` exporting
`{ id, displayName, apiKeyEnv, baseUrl, probe({ apiKey, baseUrl, request, state, config, now }) }`,
register it in `PROVIDERS` (`lib/probe.mjs`), and give it a short code in `client.js`.

## The composer pill

The pill shows **only the provider the session is currently routed to**:

```
● CC GOAT · 5h 3% · 周 14% · 月 16%  ▴
```

Clicking it opens a panel **above** the pill listing every provider (the current one highlighted);
clicking again, clicking outside, or `Esc` closes it.

The selection is read from the GUI's own model directory —
`ctx.modelDirectories.directoryFor(sessionId).store.getSnapshot().current.provider`, the same state
the composer's model seat renders from. The read is defensive: `directoryFor` throws by design until
the session scope is bound (so it retries and re-resolves when the directory instance is rebuilt),
and an unknown selection degrades to a neutral pill that **never shows another provider's numbers**.
If the model directory service is absent, the rest of the plugin still works.

## Tools

```sh
node tools/usage.mjs [--json] [--watch 60] [--only commandcode] [--key commandcode=user_…]
node tools/gen-provider-config.mjs --write     # regenerate provider/providers.yml from the live catalogue
node tools/install-provider-config.mjs <profile>/cordis.patch.yml   # splice the marked region in
```

`gen-provider-config.mjs` also emits the **llm-pi-ai model route** for CommandCode (its model list
comes from `GET /provider/v1/models`, filtered to the models served over `/chat/completions`), and
`install-provider-config.mjs` writes it into a profile inside a marked region, so a re-run replaces
it instead of appending a second copy.

## Tests

```sh
npm test          # offline: auth/HTTP/credential chain + client rendering (no key, no network)
npm run test:live # hits the real provider APIs (skips whatever it has no key for)
```

- `tools/test-auth.mjs` — the whole HTTP and credential contract against a stub `fetch`: exactly one
  `Bearer` header, `Bearer Bearer` impossible, a missing key makes no request, 401/403/quota/TLS/
  timeout classification, error de-duplication, and the six-step credential chain. 102 checks.
- `tools/test-client.mjs` — the browser half without a browser: module contract, slot registration,
  rendering, the selection-aware pill and its panel, plus the degraded states.
- `tools/test-host.mjs` — the host half against the live APIs; a provider without a key, or one whose
  upstream is down, is reported as `SKIP` with the reason, so the suite stays meaningful anywhere.

## Uninstall

```sh
"$DSH" plugin --profile desktop remove dsh-plan-usage
```

## Notes and limitations

- Probes depend on each provider's account API; if one changes, that card stops reporting (model
  requests are unaffected).
- CommandCode's monthly window needs *both* the balance call and the subscription call: when either
  is missing the window is omitted rather than computed from the half that arrived.
- Claude models are not part of the CommandCode route — they answer on the Anthropic wire.
- Reasoning-effort ladders in the generated route come from the provider's own CLI table; models it
  does not list declare no effort levels.

## 中文说明

给 DeepSeek Harness（DSH）profile 用的**套餐用量插件**：宿主进程用各家自己的密钥去查额度，
浏览器只读数字，密钥不进浏览器。

- **CommandCode**：5 小时 / 周 / 月三条窗口（金额 + 重置倒计时 + 剩余额度 + 本期请求消费）
- **OpenCode Go**：rolling / weekly / monthly 三条窗口（该套餐只有百分比）
- **设置 →「套餐用量」**：每家一张卡，并显示这轮探测用的密钥来源与脱敏值
- **输入区小胶囊**：只显示当前会话选中的那家，点一下向上展开全部提供商
- 密钥按六级链路解析（宿主凭证记录 → 凭证缝 → 环境变量 → 提供商 CLI 环境变量 → CLI 登录文件
  → `.credentials.yaml`）；失败按类分级，**多个端点同时 401 只显示一行**；换 key 无需重启

安装、配置、工具与测试见上文英文部分。`npm test` 不需要任何密钥即可运行。

## License

MIT — see [LICENSE](LICENSE).
