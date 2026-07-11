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
- 추진단계(stage_idx) 데이터는 OA-2254 API가 별도 백엔드라 클라우드 러너(Azure)에서 TCP 차단됨 — 현재 전체 0으로 표시, 해결하려면 한국 리전 러너 또는 대체 소스(cleanhome.or.kr) 필요
- git 자동커밋 시 `git reset --hard origin/main` 후 새 데이터만 복원하는 방식으로 push 충돌 방지

## 필요한 GitHub Actions Secrets
Tracker에서 이 저장소로 옮기며 시크릿은 자동 이전되지 않으므로, Settings → Secrets and variables → Actions에서 아래 값을 다시 등록해야 자동수집 워크플로가 동작합니다.
- `SEOUL_API_KEY`
- `GG_API_KEY`
- `DATA_GO_KR_KEY`

## 개발 규칙
- 코드 변경 후 반드시 `git push origin main` (GitHub Pages 자동 반영)
- 단일 파일 원칙 유지 (외부 라이브러리 최소화)
- LocalStorage 우선, Supabase는 선택적 동기화 (violations.html)
