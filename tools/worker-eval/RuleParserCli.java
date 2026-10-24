import com.malhaedwo.pttprobe.KoreanCommandParser;
import com.malhaedwo.pttprobe.ParsedCommand;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;

/**
 * Runs the unchanged Android rule parser on evaluation text, one "id<TAB>text" per line.
 * Usage: java -Duser.timezone=Asia/Seoul RuleParserCli 2026-10-21T09:00:00+09:00 < cases.tsv
 */
public final class RuleParserCli {
    public static void main(String[] args) throws Exception {
        long reference = OffsetDateTime.parse(args[0]).toInstant().toEpochMilli();
        ZoneId zone = ZoneId.systemDefault();
        DateTimeFormatter iso = DateTimeFormatter.ISO_OFFSET_DATE_TIME;
        BufferedReader in = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
        String line;
        while ((line = in.readLine()) != null) {
            int tab = line.indexOf('\t');
            if (tab < 0) continue;
            String id = line.substring(0, tab);
            String text = line.substring(tab + 1);
            long started = System.nanoTime();
            ParsedCommand parsed = KoreanCommandParser.parse(text, reference);
            long micros = (System.nanoTime() - started) / 1000;
            String start = parsed.startAt == 0 ? "" : iso.format(Instant.ofEpochMilli(parsed.startAt).atZone(zone).toOffsetDateTime());
            System.out.println("{\"id\":" + json(id) + ",\"kind\":" + json(parsed.kind) + ",\"title\":" + json(parsed.title)
                    + ",\"startAt\":" + json(start) + ",\"needsReview\":" + parsed.needsReview + ",\"micros\":" + micros + "}");
        }
    }

    private static String json(String value) {
        StringBuilder out = new StringBuilder("\"");
        for (char c : value.toCharArray()) {
            if (c == '"' || c == '\\') out.append('\\').append(c);
            else if (c < 0x20) out.append(String.format("\\u%04x", (int) c));
            else out.append(c);
        }
        return out.append('"').toString();
    }
}
