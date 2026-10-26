package com.malhaedwo.pttprobe;

import java.time.DayOfWeek;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.LocalTime;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.time.temporal.TemporalAdjusters;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public final class KoreanCommandParser {
    private static final String TITLE_POSTPOSITION = "(?:은|는|이|가|을|를|에|에서|까지|부터)?";
    private static final String TIME_TEXT = "(?:(오전|오후|아침|낮|저녁|밤|새벽)\\s*)?(\\d{1,2})시(?:\\s*(?:(\\d{1,2})분|(반)))?";
    private static final Pattern ABSOLUTE_DATE = Pattern.compile("(?:(\\d{4})년\\s*)?(\\d{1,2})월\\s*(\\d{1,2})일");
    private static final Pattern SLASH_DATE = Pattern.compile("(?<!\\d)(\\d{1,2})[./-](\\d{1,2})(?!\\d)");
    private static final Pattern TIME = Pattern.compile(TIME_TEXT);
    private static final Pattern TITLE_TIME = Pattern.compile(TIME_TEXT + TITLE_POSTPOSITION);
    private static final Pattern CONVERSATIONAL_EVENT_TIME = Pattern.compile(
            "(.+?)\\s+(?:가는|만나는|시작하는|출발하는)\\s+시간(?:은|이)?");
    private static final String EVENT_WORDS = "회의|약속|미팅|수업|상담|면담|행사|출장|병원|진료|검사|식사|점심|저녁|만나|모임|예배|공연|영화|출발|도착";
    private static final String TASK_WORDS = "할 일|해야|하기|사기|구매|제출|보내|전화|연락|확인|준비|챙기|예약하기|납부|결제|정리|작성|답장|신청";

    private KoreanCommandParser() {}

    public static ParsedCommand parse(String raw, long capturedAtMillis) {
        ZoneId zone = ZoneId.systemDefault();
        ZonedDateTime now = ZonedDateTime.ofInstant(java.time.Instant.ofEpochMilli(capturedAtMillis), zone);
        String normalized = normalize(raw);
        boolean mentionsDate = ABSOLUTE_DATE.matcher(normalized).find() || SLASH_DATE.matcher(normalized).find();
        LocalDate date = parseDate(normalized, now.toLocalDate());
        boolean hasDate = date != null;
        boolean invalidDate = mentionsDate && !hasDate;
        LocalTime time = parseTime(normalized);
        boolean hasTime = time != null;
        boolean rollsToNextDay = Pattern.compile("(?<!\\d)24시").matcher(normalized).find();

        boolean taskHint = Pattern.compile(TASK_WORDS).matcher(normalized).find();
        boolean eventHint = Pattern.compile(EVENT_WORDS).matcher(normalized).find();
        String kind;
        boolean review;
        String explanation;

        if (hasTime) {
            if (date == null && !invalidDate) {
                date = now.toLocalDate();
                if (rollsToNextDay) {
                    date = date.plusDays(1);
                } else {
                    LocalDateTime candidate = LocalDateTime.of(date, time);
                    if (candidate.atZone(zone).isBefore(now)) date = date.plusDays(1);
                }
            } else if (date != null && rollsToNextDay) {
                date = date.plusDays(1);
            }
            kind = taskHint && !eventHint ? "TODO" : "SCHEDULE";
            review = invalidDate;
            explanation = invalidDate ? "날짜가 올바르지 않아 확인이 필요함" : ("TODO".equals(kind)
                    ? "날짜·시간이 있는 행동을 할 일로 분류"
                    : (hasDate ? "날짜와 시간을 찾음" : "시간을 찾고 다음 시점으로 날짜를 추정함"));
        } else if (hasDate && eventHint && !taskHint) {
            time = LocalTime.of(9, 0);
            kind = "SCHEDULE";
            review = true;
            explanation = "날짜만 있는 일정이라 오전 9시로 임시 지정";
        } else {
            kind = "TODO";
            review = invalidDate || (hasDate && !taskHint);
            explanation = invalidDate ? "날짜가 올바르지 않아 확인이 필요함" :
                    (hasDate ? "시간 없는 항목을 날짜가 있는 할 일로 분류" : "날짜와 시간이 없어 할 일로 분류");
            if (hasDate) time = LocalTime.of(9, 0);
        }

        long startAt = 0;
        long endAt = 0;
        long reminderAt = 0;
        if (date != null && time != null) {
            ZonedDateTime start = ZonedDateTime.of(date, time, zone);
            startAt = start.toInstant().toEpochMilli();
            endAt = start.plusHours(1).toInstant().toEpochMilli();
            if ("SCHEDULE".equals(kind)) {
                reminderAt = startAt;
            } else {
                reminderAt = startAt;
            }
        }

        String title = cleanTitle(normalized);
        if (title.isEmpty()) title = "음성 메모";
        if (title.length() > 80) title = title.substring(0, 80).trim();
        return new ParsedCommand(kind, title, startAt, endAt, reminderAt, review, explanation);
    }

    /** 시각(「3시」, 「오후 2시 반」)을 실제로 말했는지. 날짜만 있는 항목의 09:00 대신 값과 구별한다. */
    public static boolean hasClockTime(String raw) {
        return parseTime(normalize(raw)) != null;
    }

    private static String normalize(String text) {
        String value = text == null ? "" : text.trim().replaceAll("\\s+", " ");
        String[][] replacements = {
                {"열두 시", "12시"}, {"열한 시", "11시"}, {"열 시", "10시"},
                {"아홉 시", "9시"}, {"여덟 시", "8시"}, {"일곱 시", "7시"},
                {"여섯 시", "6시"}, {"다섯 시", "5시"}, {"네 시", "4시"},
                {"세 시", "3시"}, {"두 시", "2시"}, {"한 시", "1시"},
                {"열두시", "12시"}, {"열한시", "11시"}, {"열시", "10시"},
                {"아홉시", "9시"}, {"여덟시", "8시"}, {"일곱시", "7시"},
                {"여섯시", "6시"}, {"다섯시", "5시"}, {"네시", "4시"},
                {"세시", "3시"}, {"두시", "2시"}, {"한시", "1시"}
        };
        for (String[] replacement : replacements) value = value.replace(replacement[0], replacement[1]);
        return value;
    }

    private static LocalDate parseDate(String text, LocalDate today) {
        Matcher absolute = ABSOLUTE_DATE.matcher(text);
        if (absolute.find()) {
            int year = absolute.group(1) == null ? today.getYear() : Integer.parseInt(absolute.group(1));
            int month = Integer.parseInt(absolute.group(2));
            int day = Integer.parseInt(absolute.group(3));
            try {
                LocalDate result = LocalDate.of(year, month, day);
                if (absolute.group(1) == null && result.isBefore(today)) result = result.plusYears(1);
                return result;
            } catch (RuntimeException ignored) { return null; }
        }
        Matcher slash = SLASH_DATE.matcher(text);
        if (slash.find()) {
            try {
                LocalDate result = LocalDate.of(today.getYear(), Integer.parseInt(slash.group(1)), Integer.parseInt(slash.group(2)));
                if (result.isBefore(today)) result = result.plusYears(1);
                return result;
            } catch (RuntimeException ignored) { return null; }
        }
        if (text.contains("글피")) return today.plusDays(3);
        if (text.contains("모레")) return today.plusDays(2);
        if (text.contains("내일")) return today.plusDays(1);
        if (text.contains("오늘")) return today;

        DayOfWeek weekday = findWeekday(text);
        if (weekday != null) {
            if (text.contains("다음 주") || text.contains("다음주")) {
                LocalDate nextMonday = today.with(TemporalAdjusters.next(DayOfWeek.MONDAY));
                return nextMonday.plusDays(weekday.getValue() - 1L);
            }
            LocalDate sameOrNext = today.with(TemporalAdjusters.nextOrSame(weekday));
            if (sameOrNext.equals(today) && !text.contains("이번")) return sameOrNext.plusWeeks(1);
            return sameOrNext;
        }
        return null;
    }

    private static DayOfWeek findWeekday(String text) {
        if (text.contains("월요일")) return DayOfWeek.MONDAY;
        if (text.contains("화요일")) return DayOfWeek.TUESDAY;
        if (text.contains("수요일")) return DayOfWeek.WEDNESDAY;
        if (text.contains("목요일")) return DayOfWeek.THURSDAY;
        if (text.contains("금요일")) return DayOfWeek.FRIDAY;
        if (text.contains("토요일")) return DayOfWeek.SATURDAY;
        if (text.contains("일요일")) return DayOfWeek.SUNDAY;
        return null;
    }

    private static LocalTime parseTime(String text) {
        Matcher matcher = TIME.matcher(text);
        if (!matcher.find()) return null;
        int hour = Integer.parseInt(matcher.group(2));
        int minute = matcher.group(3) == null ? (matcher.group(4) == null ? 0 : 30) : Integer.parseInt(matcher.group(3));
        String period = matcher.group(1);
        if (period != null) {
            if ((period.equals("오후") || period.equals("낮") || period.equals("저녁") || period.equals("밤")) && hour < 12) hour += 12;
            if ((period.equals("오전") || period.equals("아침") || period.equals("새벽")) && hour == 12) hour = 0;
        }
        if (hour == 24) hour = 0;
        if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
        return LocalTime.of(hour, minute);
    }

    private static String cleanTitle(String text) {
        Matcher conversationalEventTime = CONVERSATIONAL_EVENT_TIME.matcher(text);
        if (conversationalEventTime.find()) {
            String conversationalTitle = conversationalEventTime.group(1).trim();
            conversationalTitle = conversationalTitle.replaceFirst(
                    "^.*(?:마친\\s+다음에|마치고|다음에|그리고|후에|(?:갈|올|할|만날)\\s+거야)\\s*[,.:;]?\\s*", "");
            conversationalTitle = conversationalTitle.replaceAll(
                    "(?:(\\d{4})년\\s*)?\\d{1,2}월\\s*\\d{1,2}일" + TITLE_POSTPOSITION, " ");
            conversationalTitle = conversationalTitle.replaceAll(
                    "오늘" + TITLE_POSTPOSITION + "|내일" + TITLE_POSTPOSITION + "|모레" + TITLE_POSTPOSITION +
                            "|글피" + TITLE_POSTPOSITION + "|이번\\s*주" + TITLE_POSTPOSITION + "|다음\\s*주" + TITLE_POSTPOSITION, " ");
            conversationalTitle = conversationalTitle.replaceAll(
                    "(?:이번\\s*)?(?:월요일|화요일|수요일|목요일|금요일|토요일|일요일)" + TITLE_POSTPOSITION, " ");
            conversationalTitle = conversationalTitle.replaceAll("\\s+", " ").trim();
            if (!conversationalTitle.isEmpty()) return conversationalTitle;
        }

        String title = text;
        title = title.replaceAll("(?:(\\d{4})년\\s*)?\\d{1,2}월\\s*\\d{1,2}일" + TITLE_POSTPOSITION, " ");
        title = title.replaceAll("(?<!\\d)\\d{1,2}[./-]\\d{1,2}(?!\\d)" + TITLE_POSTPOSITION, " ");
        title = title.replaceAll("오늘" + TITLE_POSTPOSITION + "|내일" + TITLE_POSTPOSITION + "|모레" + TITLE_POSTPOSITION + "|글피" + TITLE_POSTPOSITION + "|이번\\s*주" + TITLE_POSTPOSITION + "|다음\\s*주" + TITLE_POSTPOSITION, " ");
        title = title.replaceAll("(?:이번\\s*)?(?:월요일|화요일|수요일|목요일|금요일|토요일|일요일)" + TITLE_POSTPOSITION, " ");
        title = TITLE_TIME.matcher(title).replaceAll(" ");
        title = title.replaceAll("(일정|스케줄|할\\s*일|메모)(?:은|는|이|가|을|를|로|으로)?\\s*(추가|등록|저장)?\\s*(해\\s*줘|해줘|해\\s*주세요|해주세요)?", " ");
        title = title.replaceAll("(추가|등록|저장)\\s*(해\\s*줘|해줘|해\\s*주세요|해주세요)", " ");
        title = title.replaceAll("(알려|알려줘|알려 줘|기억해|기억해줘|기억해 줘|잊지\\s*말고|까지)", " ");
        title = title.replaceAll("\\s+", " ").trim();
        title = title.replaceAll("^[,.:;]+|[,.:;]+$", "").trim();
        return title;
    }
}
