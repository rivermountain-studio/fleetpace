# 처음 쓰는 법 / First use

## 한 줄로 돌리기
- 맥·리눅스: `node fleetpace-report.mjs`
- 윈도우(명령 프롬프트·PowerShell): `node fleetpace-report.mjs`
- 언어: `--lang ko` · `--lang en` · `--lang ja` · `--lang zh` (안 주면 시스템 언어)
- 카드 그림(공유용 HTML 한 장): `node fleetpace-report.mjs --html` → `fleetpace-report.html`
- 지금 페이스만: `node fleetpace-report.mjs status --json`

Node 18 이상이 필요합니다(`node --version`). 설치할 것은 없습니다.

처음 실행은 기록 양에 따라 수십 초 걸립니다(우리 맥: 기록 52GB 를 26~70초). 두 번째부터는 늘어난 부분만 읽어 1~2초입니다.

## 읽는 것 / 안 읽는 것
| 읽는 곳 | 읽는 칸 |
|---|---|
| `~/.claude/projects/*/*.jsonl` (윈도우 `%USERPROFILE%\.claude\projects`) | 줄의 시각·종류, 토큰 숫자, 모델 이름, 한도 오류 칸(`error`·`rateLimitType`·`resetsAt`), 작업 폴더의 끝 이름 |
| `~/.claude/projects/*/<세션>/subagents/agent-*.meta.json` | 설명의 첫 낱말(팀 이름표), `model` |
| `~/.codex/sessions/**/rollout-*.jsonl` | `token_count` 줄의 한도 % 와 리셋 시각 |

안 읽는 것: 대화 글, 프롬프트, 코드, 도구 출력, 자격 증명(`.credentials.json`, `auth.json`, 키체인). 네트워크 연결 없음.

`CLAUDE_CONFIG_DIR`·`CODEX_HOME` 을 쓰면 그 아래를 읽습니다. 다른 곳이면 `--claude-dir`·`--codex-dir`.

## 지우는 법
- 리포트 파일 하나(`fleetpace-report.mjs`)를 지우면 끝입니다.
- 캐시까지 지우려면 `~/.fleetpace` 폴더를 지웁니다(숫자만 들어 있음).
- 설정 파일은 하나도 고치지 않으므로 되돌릴 것이 없습니다.

## 숫자 읽는 법
- **한도에 걸린 창**: 한도 오류 줄을 리셋 시각으로 묶은 수. 같은 창에서 여러 번 걸려도 1개.
- **가장 아까운 한 번**: 걸린 순간 리셋까지 남아 있던 시간이 가장 긴 창. ("그만큼 일을 못 했다"는 뜻이 아닙니다 — 다른 도구로 일했을 수 있습니다.)
- **누가 태웠나**: 약(가중 토큰) = 입력 + 5×출력 + 1.25×캐시 쓰기 + 0.1×캐시 읽기, 모델 가중 큰 1.0 · 중간 0.6 · 작은 0.2. 실제 한도 계산식이 아니라 비교용입니다.
- **지금 페이스**: Codex 는 Codex 가 적은 % 그대로. Claude Code 는 기록에 % 가 없어서, 지난번 걸렸을 때까지 태운 양으로 "약"을 추정합니다. 리셋 시각이 두 갈래면(계정이 여럿) 추정하지 않고 걸린 창만 보여 줍니다.
