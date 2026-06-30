/**
 * 서울시 재개발·재건축 데이터 자동 업데이트 스크립트
 * GitHub Actions에서 매일 실행됨.
 *
 * 필요한 GitHub Secrets:
 *   SEOUL_API_KEY  - 서울 열린데이터광장 API 키 (data.seoul.go.kr 가입 후 무료 발급)
 *   DATA_GO_KR_KEY - 공공데이터포털 API 키 (data.go.kr 가입 후 무료 발급)
 *
 * API 키 없으면 updated_at 타임스탬프만 갱신하고 기존 데이터 유지.
 */

const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, '..', 'data', 'redevelopment.json');
const TODAY = new Date().toISOString().split('T')[0];

const SEOUL_KEY = process.env.SEOUL_API_KEY;
const DATA_GO_KR_KEY = process.env.DATA_GO_KR_KEY;

// 서울시 정비사업 단계명 → stage_idx 매핑
const STAGE_MAP = {
  '정비구역지정': 0,
  '구역지정': 0,
  '추진위원회구성': 1,
  '추진위': 1,
  '조합설립인가': 1,
  '조합설립': 1,
  '사업시행인가': 2,
  '사업시행': 2,
  '관리처분인가': 3,
  '관리처분': 3,
  '착공': 4,
  '이주': 4,
  '철거': 4,
  '준공': 5,
  '입주': 5,
  '완료': 5,
};

function getStageIdx(stageName) {
  if (!stageName) return 0;
  for (const [key, idx] of Object.entries(STAGE_MAP)) {
    if (stageName.includes(key)) return idx;
  }
  return 0;
}

async function fetchSeoulData() {
  if (!SEOUL_KEY) {
    console.log('[SEOUL API] API 키 없음 — 건너뜀. SEOUL_API_KEY secret을 설정하세요.');
    return null;
  }

  console.log('[SEOUL API] 서울시 정비사업 데이터 요청 중...');
  try {
    // 서울시 열린데이터광장 도시정비사업 현황 API
    // 실제 서비스명은 data.seoul.go.kr 에서 확인 필요
    const url = `http://openapi.seoul.go.kr:8088/${SEOUL_KEY}/json/JsGisJeongseBitList/1/1000/`;
    const res = await fetch(url);
    const json = await res.json();

    const root = json.JsGisJeongseBitList || json;
    const rows = root.row || [];

    if (rows.length === 0) {
      console.warn('[SEOUL API] 데이터 없음 또는 API 응답 구조 다름:', JSON.stringify(json).substring(0, 200));
      return null;
    }

    console.log(`[SEOUL API] ${rows.length}개 구역 데이터 수신`);

    return rows.map((r, i) => ({
      id: `seoul_${i}`,
      name: r.JEONGBE_NM || r.SBSN_NM || '알 수 없음',
      district: r.SGG_NM || '',
      dong: r.EMD_NM || '',
      type: (r.JEONGBE_SE_NM || '').includes('재건축') ? '재건축' : '재개발',
      stage: r.S업_STEP_NM || r.STEP_NM || '',
      stage_idx: getStageIdx(r.S업_STEP_NM || r.STEP_NM || ''),
      lat: parseFloat(r.LAT || r.Y_COORD || 0),
      lng: parseFloat(r.LON || r.X_COORD || 0),
      area_m2: parseInt(r.JEONGBE_AREA || 0),
      units: parseInt(r.TOT_HSHLD_CO || 0),
      contractor: r.CNSTR_CO_NM || '',
      stage_date: r.STEP_DT ? r.STEP_DT.substring(0, 7) : '',
      notes: '',
    })).filter(p => p.lat && p.lng);

  } catch (e) {
    console.error('[SEOUL API] 오류:', e.message);
    return null;
  }
}

async function main() {
  // 기존 데이터 로드
  let existing = { updated_at: TODAY, source: 'sample', projects: [] };
  if (fs.existsSync(DATA_FILE)) {
    existing = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
  }

  // API로 새 데이터 시도
  const newProjects = await fetchSeoulData();

  if (newProjects && newProjects.length > 0) {
    existing.projects = newProjects;
    existing.source = 'seoul_open_api';
    console.log(`[UPDATE] 실데이터 ${newProjects.length}개 구역으로 업데이트`);
  } else {
    console.log('[UPDATE] 기존 샘플 데이터 유지, 타임스탬프만 갱신');
    existing.source = existing.source || 'sample';
  }

  existing.updated_at = TODAY;
  existing.note = newProjects
    ? '서울시 열린데이터광장 실데이터'
    : '샘플 데이터. SEOUL_API_KEY secret 설정 시 실데이터로 전환됩니다.';

  fs.writeFileSync(DATA_FILE, JSON.stringify(existing, null, 2), 'utf-8');
  console.log(`[DONE] data/redevelopment.json 업데이트 완료 (${TODAY})`);
}

main().catch(e => {
  console.error('스크립트 오류:', e);
  process.exit(1);
});
