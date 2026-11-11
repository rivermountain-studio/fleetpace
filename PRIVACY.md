# Privacy / 개인정보

- Fleetpace sends nothing off your computer. The report file contains no network code (checked by a test: no `http`, `https`, `net`, `dgram`, `tls`, `dns`, `child_process`, `fetch`).
- It reads only the fields listed in README ("What it reads"). It never opens conversation text, credentials or keychains.
- It writes only `~/.fleetpace/cache-v1.json` (token numbers per 10-minute bucket, limit-hit times, hashed file keys, project folder base names) and, if asked, an HTML card. Delete `~/.fleetpace` to remove everything.

- Fleetpace 는 이 컴퓨터 밖으로 아무것도 보내지 않습니다. 리포트 파일 안에 네트워크 코드가 없습니다(시험으로 검사).
- README 의 "읽는 것" 칸만 읽습니다. 대화 글·자격 증명·키체인은 열지 않습니다.
- 쓰는 곳은 `~/.fleetpace/cache-v1.json`(10분 단위 토큰 숫자, 한도에 걸린 시각, 해시한 파일 키, 프로젝트 폴더 끝 이름)과 요청한 HTML 카드뿐입니다. `~/.fleetpace` 를 지우면 전부 사라집니다.
