# Blackhole Desktop 0.1.1 for Windows

블랙홀의 한국어 음성 승인 데스크를 Windows에서 검토하기 위한 첫 설치형 컴패니언입니다. Tauri v2, Vite, 바닐라 TypeScript로 구성했습니다.

## 현재 범위

- 한국어 Windows 행정 업무에 맞춘 승인 문서함 UI: 고정 탐색, 검토 대기열, 큰 기록 점검면
- Windows 네이티브 글꼴 계층, 명확한 선택 레일, WCAG AA 수준의 핵심 텍스트 대비
- 장식용 영문·모노스페이스 메타데이터·반복 카드·그림자·그라데이션을 배제한 절제된 구조
- 키보드 포커스, 상태 필터, 목록 선택, 800px 이하 세로 재배치, reduced-motion 지원
- 상세 설계 계약은 `DESIGN.md`에 기록
- 공개 웹 `Items` 시트의 23개 컬럼 계약을 TypeScript와 Rust 타입으로 반영
- 앱 데이터 폴더의 버전 1 JSON 캐시 읽기와 원자적 저장
- 손상 캐시 격리 후 빈 캐시 복구
- 연결 상태를 항상 `unconfigured` / `Google 미연결` / 읽기 전용으로 보고
- 실제 사용자 데이터가 아닌 명시적 가상 픽스처 3건
- NSIS와 MSI 번들, 현재 사용자 NSIS 설치, WebView2 다운로드 부트스트래퍼

이 버전은 **로컬 미리보기**입니다. 네트워크 요청, 원격 콘텐츠, 임의 URL 열기, shell, 범용 파일 시스템 플러그인, Google 자격 증명을 포함하지 않습니다. 승인, 수정, 삭제, Calendar 전송 컨트롤은 이유와 함께 비활성화되어 있습니다.

## 개발 명령

Node.js 20 이상과 Rust/Tauri의 Windows 빌드 전제 조건이 필요합니다.

```powershell
npm ci
npm test
npm run build
npm run acceptance
cargo test --locked --manifest-path src-tauri/Cargo.toml
npm run tauri dev
```

처음 Rust 의존성 잠금을 만드는 환경에서는 먼저 다음을 실행합니다.

```powershell
cargo generate-lockfile --manifest-path src-tauri/Cargo.toml
```

이 작업 환경에는 Rust가 없어 `Cargo.lock` 생성과 Rust 테스트를 로컬에서 실행하지 않았습니다. Windows CI는 lockfile이 없을 때 먼저 생성한 다음 반드시 `cargo test --locked`를 실행합니다.

## Windows 설치본

```powershell
npm run tauri build -- --bundles nsis,msi
```

성공한 출력은 다음 폴더에 생깁니다.

- `src-tauri/target/release/bundle/nsis/`: 현재 사용자용 `*-setup.exe`
- `src-tauri/target/release/bundle/msi/`: `.msi`

저장소 루트의 `.github/workflows/windows-desktop.yml`은 데스크톱 브랜치 push, PR과 수동 실행에서 프런트엔드 테스트/빌드, 잠긴 Rust 테스트, NSIS+MSI 빌드를 수행하고 설치본을 Actions artifact로 올립니다. 릴리스 게시 작업은 없습니다.

## Google OAuth 차단점

Google 연결은 의도적으로 구현하지 않았습니다. 다음 단계에서는 공개 저장소에 운영 설정을 넣지 않는 데스크톱 OAuth 설계, OS 보안 저장소, 최소 scope, 계정 선택, 연결 해제와 오류 상태부터 별도 검토해야 합니다. 이 안전 경계가 정해지기 전에는 승인이나 Calendar 쓰기를 켜지 않습니다.

## 다음 단계

1. Windows CI에서 0.1.1 Rust 단위 테스트와 NSIS/MSI 설치본 생성 확인
2. 서명되지 않은 개인 설치본의 Windows 안내와 실제 설치/제거·100/125/150% 배율 검증
3. 안전한 OAuth 및 읽기 전용 동기화 설계
4. revision, tombstone, idempotency 계약을 확정한 뒤 승인 쓰기 활성화
5. 네이티브 알림, 절전 복귀, 트레이, 시작 프로그램 순으로 검증

## 소스 수준 검사

Rust가 없는 환경에서도 다음 명령이 제품명/버전, 23컬럼, 픽스처 수, 읽기 전용 상태, CSP, 최소 capability, 번들 설정, 워크플로와 민감 정보 부재를 검사합니다.

```powershell
npm run acceptance
```
