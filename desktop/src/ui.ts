import type { ConnectionStatus, Item, ItemStatus } from "./domain";
import { WRITE_DISABLED_REASON } from "./domain";

type Filter = "ALL" | "PENDING" | "APPROVED";

const statusLabel: Record<ItemStatus, string> = {
  PENDING: "승인 대기",
  APPROVED: "승인됨",
  DONE: "완료",
  DELETED: "삭제됨"
};

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatDate(value: string): string {
  if (!value) return "시각 없음";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "시각 확인 필요";
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function compactDate(value: string): string {
  if (!value) return "기한 없음";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "확인 필요";
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function itemButton(item: Item, selectedId: string): string {
  const active = item.itemId === selectedId;
  const area = item.area === "SCHOOL" ? "학교" : "개인";
  const kind = item.kind === "TODO" ? "할 일" : "일정";
  return `<button class="queue-item${active ? " is-selected" : ""}" type="button"
    data-item-id="${escapeHtml(item.itemId)}" aria-pressed="${active}">
    <span class="queue-item__top">
      <span class="record-state record-state--${item.status.toLowerCase()}">${statusLabel[item.status]}</span>
      <time>기록 ${compactDate(item.createdAt)}</time>
    </span>
    <strong>${escapeHtml(item.title || "제목 없음")}</strong>
    <span class="queue-item__facts">
      <span><b>분류</b>${area}, ${kind}</span>
      <span><b>예정</b>${compactDate(item.startAt)}</span>
    </span>
  </button>`;
}

function detailPane(item: Item | undefined): string {
  if (!item) {
    return `<section class="detail empty-detail" aria-live="polite">
      <h2>표시할 기록이 없습니다</h2>
      <p>다른 상태 필터를 선택해 보세요.</p>
    </section>`;
  }

  const reason = escapeHtml(WRITE_DISABLED_REASON);
  const area = item.area === "SCHOOL" ? "학교" : "개인";
  const kind = item.kind === "TODO" ? "할 일" : "일정";

  return `<section class="detail" aria-labelledby="detail-title" data-testid="detail-pane">
    <header class="record-header">
      <div class="record-header__state">
        <span class="record-state record-state--${item.status.toLowerCase()}">${statusLabel[item.status]}</span>
        <span>${escapeHtml(item.sourceType)}에서 기록</span>
        <time>${formatDate(item.createdAt)}</time>
      </div>
      <h2 id="detail-title">${escapeHtml(item.title)}</h2>
      <p>${area} 기록의 ${kind === "할 일" ? "할 일로" : "일정으로"} 해석되었습니다.</p>
    </header>

    <div class="record-body">
      <section class="record-section transcript" aria-labelledby="transcript-title">
        <h3 id="transcript-title">기록된 말</h3>
        <blockquote>${escapeHtml(item.transcript || "원문 없음")}</blockquote>
      </section>

      <section class="record-section" aria-labelledby="schedule-title">
        <h3 id="schedule-title">일정 정보</h3>
        <dl class="record-grid">
          <div class="record-field record-field--wide">
            <dt>제목</dt><dd>${escapeHtml(item.title)}</dd>
          </div>
          <div><dt>분류</dt><dd>${area}</dd></div>
          <div><dt>종류</dt><dd>${kind}</dd></div>
          <div class="record-field--wide"><dt>예정 시각</dt><dd>${escapeHtml(formatDate(item.startAt))}</dd></div>
          <div><dt>알림</dt><dd>${escapeHtml(formatDate(item.reminderAt))}</dd></div>
          <div><dt>Google Calendar</dt><dd>사용 안 함</dd></div>
          <div class="record-field--full"><dt>메모</dt><dd>${escapeHtml(item.notes || "메모 없음")}</dd></div>
        </dl>
        <select class="visually-hidden" data-testid="calendar-control" disabled title="${reason}" aria-label="Google Calendar"><option>사용 안 함</option></select>
      </section>

      <section class="record-section record-status" aria-labelledby="data-title">
        <h3 id="data-title">데이터 상태</h3>
        <dl>
          <div><dt>검토</dt><dd>${statusLabel[item.status]}</dd></div>
          <div><dt>출처</dt><dd>인공 예시</dd></div>
          <div><dt>저장</dt><dd>이 컴퓨터에만</dd></div>
          <div><dt>버전</dt><dd>${item.version}</dd></div>
        </dl>
      </section>
    </div>

    <div class="action-area">
      <div class="write-notice" id="write-disabled-reason" role="status" data-testid="write-disabled-status">
        <strong>지금은 읽기 전용입니다.</strong>
        <span>${escapeHtml(WRITE_DISABLED_REASON)}</span>
      </div>
      <footer class="actions">
        <button class="danger" type="button" disabled aria-describedby="write-disabled-reason" title="${reason}">삭제</button>
        <button type="button" disabled aria-describedby="write-disabled-reason" title="${reason}">수정 저장</button>
        <button class="primary" type="button" disabled aria-describedby="write-disabled-reason" title="${reason}">확인 후 승인</button>
      </footer>
    </div>
  </section>`;
}

export function createApp(root: HTMLElement, items: Item[], connection: ConnectionStatus): void {
  let filter: Filter = "ALL";
  let selectedId = items.find((item) => item.status !== "DELETED")?.itemId ?? "";

  const filtered = (): Item[] => items.filter((item) =>
    item.status !== "DELETED" && (filter === "ALL" || item.status === filter)
  );

  function render(): void {
    const visible = filtered();
    if (!visible.some((item) => item.itemId === selectedId)) selectedId = visible[0]?.itemId ?? "";
    const selected = items.find((item) => item.itemId === selectedId);
    const pending = items.filter((item) => item.status === "PENDING").length;
    const approved = items.filter((item) => item.status === "APPROVED").length;

    root.innerHTML = `<div class="app-shell">
      <aside class="sidebar">
        <div class="brand" aria-label="Blackhole Desktop"><span>야</span><small>Desktop</small></div>
        <nav aria-label="주 메뉴">
          <button class="nav-button is-active" type="button" aria-current="page"><span aria-hidden="true"></span>승인 데스크</button>
          <button class="nav-button" type="button" disabled title="후속 버전에서 제공됩니다."><span aria-hidden="true"></span>등록된 일정</button>
          <button class="nav-button" type="button" disabled title="후속 버전에서 제공됩니다."><span aria-hidden="true"></span>알림 기록</button>
          <button class="nav-button" type="button" disabled title="후속 버전에서 제공됩니다."><span aria-hidden="true"></span>설정</button>
        </nav>
        <div class="sidebar__version">개인용 미리보기<br>버전 0.1.1</div>
      </aside>

      <main>
        <header class="topbar">
          <div class="page-title"><h1>승인 데스크</h1><p>말로 남긴 기록을 확인합니다.</p></div>
          <div class="topbar__summary" aria-label="항목 상태 요약">
            <span>승인 대기 <b data-testid="pending-count">${pending}</b></span>
            <span>승인됨 <b>${approved}</b></span>
          </div>
          <div class="connection" aria-label="연결 상태"><span aria-hidden="true"></span><strong>${escapeHtml(connection.label)}</strong></div>
        </header>

        <section class="preview-banner" role="status" data-testid="preview-banner">
          <strong>${escapeHtml(connection.label)} 상태의 로컬 미리보기</strong>
          <span>${escapeHtml(connection.detail)}</span>
        </section>

        <div class="workspace">
          <section class="inbox" aria-label="항목 목록">
            <header class="inbox__head">
              <div><h2>검토할 기록</h2><span>${visible.length}건</span></div>
              <div class="filters" role="group" aria-label="상태 필터">
                <button type="button" data-filter="ALL" aria-pressed="${filter === "ALL"}">전체</button>
                <button type="button" data-filter="PENDING" aria-pressed="${filter === "PENDING"}">대기</button>
                <button type="button" data-filter="APPROVED" aria-pressed="${filter === "APPROVED"}">승인</button>
              </div>
            </header>
            <div class="item-list" data-testid="item-list">
              ${visible.length ? visible.map((item) => itemButton(item, selectedId)).join("") : '<p class="empty-list">표시할 기록이 없습니다.</p>'}
            </div>
          </section>
          ${detailPane(selected)}
        </div>
      </main>
    </div>`;

    root.querySelectorAll<HTMLButtonElement>("[data-filter]").forEach((button) => {
      button.addEventListener("click", () => {
        filter = button.dataset.filter as Filter;
        render();
        root.querySelector<HTMLButtonElement>(`[data-filter="${filter}"]`)?.focus();
      });
    });
    root.querySelectorAll<HTMLButtonElement>("[data-item-id]").forEach((button) => {
      button.addEventListener("click", () => {
        selectedId = button.dataset.itemId ?? "";
        render();
        Array.from(root.querySelectorAll<HTMLButtonElement>("[data-item-id]"))
          .find((candidate) => candidate.dataset.itemId === selectedId)?.focus();
      });
    });
  }

  render();
}
