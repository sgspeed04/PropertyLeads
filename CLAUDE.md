# 한상규 — 부동산 리드 & 데이터 자동수집

## 나에 대해
- 직업: 해외 영업 + ERP/BI 담당
- 부업: 위반건축물 소유주 ↔ 건축사 소개 수수료 사업, 재개발·재건축 리서치
- 이 저장소는 [sgspeed04/Tracker](https://github.com/sgspeed04/Tracker) (개인 습관/자문/스마트스토어 관리)에서 부동산 관련 도구만 분리한 저장소입니다 — 두 저장소는 인프라(공공데이터 자동수집 스크립트 + GitHub Actions)를 공유하는 성격이라 별도 관리합니다.

## 프로젝트 구조

| 파일 | 용도 | URL |
|------|------|-----|
| `violations.html` | 위반건축물 리드 관리 + 건축사 협업 CRM | https://sgspeed04.github.io/PropertyLeads/violations.html |
| `redevelopment.html` | 수도권 재개발·재건축 지도 (공공데이터 자동수집) | https://sgspeed04.github.io/PropertyLeads/redevelopment.html |

## 기술 스택
- **프론트엔드**: Vanilla JS + HTML/CSS (빌드 불필요, 단일 파일)
- **데이터베이스**: Supabase (PostgreSQL, 무료 플랜) — violations.html만 해당
- **호스팅**: GitHub Pages (무료)
- **저장소**: github.com/sgspeed04/PropertyLeads (main 브랜치 배포)
- **자동수집**: GitHub Actions로 매일 공공데이터/구청 게시판을 스크래핑해 `data/*.json`에 커밋

## Supabase 설정
- 프로젝트: sgspeed04's Project (sghan.biz) — Tracker와 동일 프로젝트 공유
- URL: https://fbctahxjzwwzuscjvaxg.supabase.co
- 테이블: `viol_architects`, `viol_leads`
- RLS: 활성화됨 (anon 정책 적용)

## violations.html 주요 기능
- 위반건축물 리드 관리 (주소/구·시/위반유형/확인일/상태/출처링크)
- 상태 흐름: 신규 → 컨택완료 → 건축사소개 → 계약성사 → 수수료수령 (보류/중단 분기)
- 건축사 파트너 관리 (전문분야/연락처/소개 수수료율) + 리드 배정
- 대시보드: 구/시별 리드 분포, 확정·예상 소개 수수료 합계
- 구/시 입력 시 해당 지역 위반건축물 공고 검색 바로가기 (전국 통합 오픈API 미공개 — 수기 등록 방식)
- Supabase 크로스 디바이스 동기화
- **자동수집 공고 탭**: 강남·광진·송파·성동·용산 5개 구청 공시송달/고시공고 게시판 스크래핑 결과(`data/violations_notices.json`)를 보여주고, 바로 리드로 등록하거나 숨길 수 있음
  - `scripts/fetch-violations.js`가 `.github/workflows/update-violations.yml`을 통해 매일 00:30 KST 자동 실행
  - 위반건축물 관련 키워드(철거명령/이행강제금/무단증축 등)로 제목을 필터링 — 게시판들이 다른 기관 공고도 섞어 올리기 때문
  - 과거 아카이브 백필은 게시글 번호 차이가 너무 커서 비현실적 — 매일 신규 공고만 수집하는 용도
  - 강동구는 목록이 자바스크립트로 렌더링되는 방식(CSR)이라 현재 방식(HTTP 요청 + HTML 파싱)으로 불가해 제외 — headless 브라우저 도입 시 재검토 가능
  - 다른 구/시로 확장하려면 `scripts/fetch-violations.js`의 `BOARDS` 배열에 게시판 URL 추가

## redevelopment.html 주요 기능
- 수도권(서울·경기) 재개발·재건축 구역을 지도에 표시, 뉴타운/대형 재건축 포함
- LCLSF 필드 기반으로 재개발/재건축 유형 분류, 구 이름 정규화(예: "서울특별시 광진구" → "광진구")
- `scripts/fetch-redevelopment.js`가 `.github/workflows/update-redevelopment.yml`을 통해 매일 00:00 KST 자동 실행 (서울 upisRebuild API + 경기도 data.go.kr API)
- `scripts/fetch-nohuodo.js`는 노후도 데이터를 매년 1월 1일 09:00 KST 1회만 갱신 (`data/nohuodo.json`)
- 추진단계(stage_idx) 데이터: CleanupBussinessProgress(OA-2254, HTTP:8088)는 Azure 러너에서도 접근 가능한 것으로 확인됨(TCP 차단 아니었음). 다만 이 API의 BIZ_NO는 upisRebuild의 PRJC_CD/RPT_MNG_CD와 채번 체계가 전혀 달라(둘 다 앞 5자리 구 코드만 공통) 코드로 조인 불가 — 형제 서비스(사업명 반환 API)도 존재하지 않음. 대신 TTL(공고 제목)·DTL_CN(상세내용) 필드에 구역명이 텍스트로 실려있는 것을 이용해, `normalizeProjectName()`으로 양쪽 이름에서 행정 접미어(구역/지구/재개발 등)를 제거한 뒤 같은 구 코드 내에서 부분일치시키는 방식으로 매칭 (`fetchProgressStages` + `main()`의 조인 로직, `scripts/fetch-redevelopment.js`). 서울 761개 구역 중 약 128개(~17%)만 CleanupBussinessProgress에 진행 이력이 있어 매칭됨 — 나머지는 구역지정(stage_idx=0) 단계에 머물러 있거나 조합 결성 전이라 추진경과 데이터 자체가 없는 경우로, 매칭 알고리즘의 한계가 아니라 데이터 커버리지의 한계임
- 신속통합기획 후보지: 정비사업 정보몽땅(cleanup.seoul.go.kr)의 재개발/재건축 추진현황 페이지를 크롤링해 upisRebuild 미등록 구역만 추가(`fetchSinsoktong`, id 접두사 `snt_`). 좌표는 없어 구 중심좌표 지터로만 표시(아래 VWorld 지오코딩도 `addr` 필드가 있는 `api_` 항목에만 적용됨)
- **좌표 정확도(geo_source)**: upisRebuild API 응답엔 좌표 필드가 없어 원래 전 구역이 구 중심좌표+지터로만 표시됐음. `PSTN_NM`(지번 주소, `addr` 필드로 결과 JSON에 영구 보존)을 VWorld 지오코더로 변환해 실좌표를 얻도록 개선했으나:
  - **GitHub Actions 러너(Azure IP)는 VWorld API 전체가 게이트웨이 단에서 502로 차단됨** (주소/검색/데이터 API 공통, 헤더 조정 무관) — 따라서 `update-redevelopment.yml`의 `geocodeProjects()`는 매일 실패하는 게 정상이며 지터 좌표로 안전하게 폴백함
  - **브라우저에서 fetch()로 직접 호출해도 CORS로 차단됨** (`TypeError: Failed to fetch`) — VWorld가 Access-Control-Allow-Origin을 안 보내주는 것으로 보임. `<script>` 태그 + `callback` 파라미터를 쓰는 **JSONP 방식은 우회 가능함을 확인** (same-origin 정책 미적용)
  - 그래서 실제 지오코딩은 `geocode-vworld-v2.html`(GitHub Pages에 배포된 1회성 브라우저 도구, JSONP 사용)을 사용자가 본인 브라우저(휴대폰 등, 비클라우드 IP)에서 직접 실행해 결과(JSON, id+lat+lng)를 받고, 그 결과를 데이터에 수동 병합하는 방식으로 진행함. 최초 실행 결과: 753건 중 619건 성공(`geo_source: "vworld"`), 134건은 VWorld가 인식 못 하는 주소라 지터 유지(`geo_source: "jitter"`)
  - `mergeWithExisting()`이 `geo_source === 'vworld'`인 기존 좌표를 재실행 시에도 보존하므로, 매일 자동수집이 돌아도 한 번 확보한 실좌표는 덮어써지지 않음. 새로 추가되는 구역(`addr` 있는데 `geo_source`가 vworld가 아닌 것)이 쌓이면 `geocode-vworld-v2.html`을 다시 한번 실행해서 채워 넣으면 됨
  - Claude 아티팩트(claude.ai/code/artifact) 페이지는 자체 CSP가 외부 fetch를 전부 막아서 이 용도로 쓸 수 없음 — 반드시 GitHub Pages 같은 일반 정적 호스팅에 올려야 함
- git 자동커밋 시 `git reset --hard origin/main` 후 새 데이터만 복원하는 방식으로 push 충돌 방지
- **GitHub Pages 배포가 push마다 트리거되지 않을 수 있음**: "Deploy from a branch(main)" 방식이라도 `pages build and deployment`(workflow id는 Settings → Pages에서 확인하거나 Actions API로 조회) 워크플로가 매 push마다 자동으로 도는 게 아니라 종종 몇 시간~하루씩 밀림. 새 파일을 추가했는데 404가 나면 Actions 탭에서 이 워크플로의 최근 실행 이력을 보고 해당 커밋이 실제로 배포됐는지 먼저 확인할 것 — workflow_dispatch로 수동 트리거는 불가(이벤트 기반이라 dispatch 트리거 없음)

## 필요한 GitHub Actions Secrets
Tracker에서 이 저장소로 옮기며 시크릿은 자동 이전되지 않으므로, Settings → Secrets and variables → Actions에서 아래 값을 다시 등록해야 자동수집 워크플로가 동작합니다.
- `SEOUL_API_KEY`
- `GG_API_KEY`
- `DATA_GO_KR_KEY`
- `VWORLD_KEY` (api.vworld.kr, 지오코딩용 — 단, GitHub Actions에서는 VWorld 자체 IP 차단으로 실제로는 쓰이지 못함. 위 redevelopment.html 섹션 참고)

## 개발 규칙
- 코드 변경 후 반드시 `git push origin main` (GitHub Pages 자동 반영)
- 단일 파일 원칙 유지 (외부 라이브러리 최소화)
- LocalStorage 우선, Supabase는 선택적 동기화 (violations.html)
