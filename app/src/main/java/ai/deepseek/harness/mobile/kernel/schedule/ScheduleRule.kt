package ai.deepseek.harness.mobile.kernel.schedule

import org.json.JSONArray
import org.json.JSONObject
import java.time.DayOfWeek
import java.time.Instant
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.LocalTime
import java.time.ZoneId
import java.time.ZonedDateTime

/**
 * 时间规则：校验、规范化、下一次触发计算。
 *
 * 全部是纯函数（无 Context / 无文件 / 无 System.currentTimeMillis），因此可以在 JVM
 * 单测里用假时钟精确断言 DST 与错过语义 —— 这正是原来埋在 ScheduleRegistry 里
 * 无法测试的那部分。
 *
 * 与桌面对齐的要点（`packages/schedule/schedule/src/domain.ts`）：
 *   - 五字段 Vixie cron；拒绝 `L` `W` `#`、月份/星期名、`@daily`、秒字段
 *   - dom 或 dow 任一为星号 → 两者都要匹配；都不是星号 → 匹配任一（Vixie 语义）
 *   - DST 缺失的本地时间**跳过**（不是平移），重叠取较早时点
 *   - 存储规范化表达式；`at` 只存 UTC 毫秒，不保留输入时区
 */
object ScheduleRule {

    const val MAX_TITLE = 120
    private const val MIN_EVERY_SECONDS = 60L
    /** 往后找 5 年还没有下一次触发就认为规则不可用（cron 如 `0 0 30 2 *`） */
    private const val SEARCH_YEARS = 5L

    // 存储用的选择器键（与 v1 完全同名，迁移成本为零）
    private const val K_AFTER = "after_seconds"
    private const val K_EVERY = "every_seconds"
    private const val K_AT = "at"
    private const val K_DAILY = "daily"
    private const val K_WEEKLY = "weekly"
    private const val K_CRON = "cron"
    private const val K_TZ = "timeZone"
    private const val K_TZ_LEGACY = "time_zone"

    class Parsed(val rule: JSONObject, val kind: ScheduleKind, val scheduledAt: Long)

    /* ------------------------------------------------------------------ */
    /* 校验与创建                                                          */
    /* ------------------------------------------------------------------ */

    /** 标题：去空白后非空且 ≤120（桌面 `invalid_prompt` 同义） */
    fun validateTitle(raw: String?): String {
        val t = raw?.trim().orEmpty()
        if (t.isEmpty()) throw ScheduleException.prompt("title 不能为空")
        if (t.length > MAX_TITLE) {
            throw ScheduleException.prompt("title 不能超过 $MAX_TITLE 个字符（当前 ${t.length}）")
        }
        return t
    }

    fun validatePrompt(raw: String?): String {
        val p = raw.orEmpty()
        if (p.isBlank()) throw ScheduleException.prompt("prompt 不能为空")
        return p
    }

    /**
     * 解析模型给的扁平参数（`after_seconds` / `every_seconds` / `at` / `daily` / `weekly` / `cron`）。
     * 必须恰好一种；返回规范化规则 + 下一次目标时刻。
     */
    fun parse(args: JSONObject, nowMillis: Long): Parsed {
        val present = listOf(K_AFTER, K_EVERY, K_AT, K_DAILY, K_WEEKLY, K_CRON)
            .filter { args.has(it) && !args.isNull(it) }
        if (present.isEmpty()) {
            throw ScheduleException.rule(
                "必须给出一种时间规则：after_seconds / every_seconds / at / daily / weekly / cron",
            )
        }
        if (present.size > 1) {
            throw ScheduleException.rule("时间规则只能选一种，收到：${present.joinToString(", ")}")
        }
        val selector = present[0]
        val rule = when (selector) {
            K_AFTER -> {
                val s = args.optLong(K_AFTER, 0L)
                if (s <= 0L) throw ScheduleException.rule("after_seconds 必须是正整数秒")
                JSONObject().put(K_AFTER, s)
            }

            K_EVERY -> {
                val s = args.optLong(K_EVERY, 0L)
                if (s < MIN_EVERY_SECONDS) {
                    throw ScheduleException.rule("every_seconds 至少 $MIN_EVERY_SECONDS 秒（收到 $s）")
                }
                JSONObject().put(K_EVERY, s)
            }

            K_AT -> {
                val at = atMillis(args.opt(K_AT))
                    ?: throw ScheduleException.rule(
                        "at 无法解析：需要 RFC3339 带时区字符串，或 {date,time,time_zone} 对象",
                    )
                // 桌面：绝对 at 必须严格未来；手机端不能"过去时间立刻触发"，那是说谎
                if (at <= nowMillis) {
                    throw ScheduleException.rule(
                        "at 必须是严格未来的时间（收到 ${formatIso(at, ZoneId.systemDefault())}，" +
                            "当前 ${formatIso(nowMillis, ZoneId.systemDefault())}）",
                    )
                }
                JSONObject().put(K_AT, at)   // 只存 UTC 毫秒，不保留输入时区
            }

            K_DAILY -> {
                val o = args.optJSONObject(K_DAILY)
                    ?: throw ScheduleException.rule("daily 必须是对象 {time, time_zone}")
                val time = parseTime(o.optString("time")) ?: throw ScheduleException.rule(
                    "daily.time 需要 HH:mm:ss（收到「${o.optString("time")}」）",
                )
                val zone = parseZone(tzOf(o))
                JSONObject().put(K_DAILY, JSONObject().put("time", fmtTime(time)).put(K_TZ, zone.id))
            }

            K_WEEKLY -> {
                val o = args.optJSONObject(K_WEEKLY)
                    ?: throw ScheduleException.rule("weekly 必须是对象 {time, time_zone, weekdays}")
                val time = parseTime(o.optString("time")) ?: throw ScheduleException.rule(
                    "weekly.time 需要 HH:mm:ss（收到「${o.optString("time")}」）",
                )
                val zone = parseZone(tzOf(o))
                val days = parseWeekdays(o.optJSONArray("weekdays"))
                JSONObject().put(K_WEEKLY, JSONObject().put("time", fmtTime(time)).put(K_TZ, zone.id)
                    .put("weekdays", JSONArray(days)))
            }

            else -> {
                val o = args.optJSONObject(K_CRON)
                    ?: throw ScheduleException.rule("cron 必须是对象 {expression, time_zone}")
                val zone = parseZone(tzOf(o))
                val expr = CronExpr.parse(o.optString("expression"))
                JSONObject().put(K_CRON, JSONObject().put("expression", expr.canonical).put(K_TZ, zone.id))
            }
        }
        val kind = kindOf(rule) ?: throw ScheduleException.rule("无法识别的时间规则")
        val scheduledAt = when (kind) {
            ScheduleKind.after -> nowMillis + rule.optLong(K_AFTER) * 1000L
            ScheduleKind.every -> nowMillis + rule.optLong(K_EVERY) * 1000L
            else -> nextAfter(rule, nowMillis) ?: throw ScheduleException.rule(
                "这条规则在当前时区找不到未来的触发时刻，请换一个时间或表达式",
            )
        }
        return Parsed(rule, kind, scheduledAt)
    }

    /* ------------------------------------------------------------------ */
    /* 解码/规范化                                                          */
    /* ------------------------------------------------------------------ */

    /**
     * 旧文件里 `time_zone` 下划线写法统一成 `timeZone`，其余原样保留。
     *
     * 注意：这里用 `keys()` 迭代器而不是 `keySet()` —— Android 的 android.jar 与
     * JVM 版 org.json 在 `keySet()` 的泛型声明上不一致，Kotlin 编译时会出现
     * `iterator()` 二义性；`keys()` 两边签名一致，是唯一安全写法。
     */
    fun normalizeStoredRule(raw: JSONObject): JSONObject {
        val out = JSONObject()
        val outer = raw.keys()
        while (outer.hasNext()) {
            val key = outer.next()
            when (key) {
                K_DAILY, K_WEEKLY, K_CRON -> {
                    val o = raw.optJSONObject(key) ?: continue
                    val n = JSONObject()
                    val inner = o.keys()
                    while (inner.hasNext()) {
                        val k = inner.next()
                        n.put(if (k == K_TZ_LEGACY) K_TZ else k, o.get(k))
                    }
                    out.put(key, n)
                }

                else -> out.put(key, raw.get(key))
            }
        }
        return out
    }

    fun kindOf(rule: JSONObject): ScheduleKind? = when {
        rule.has(K_AFTER) -> ScheduleKind.after
        rule.has(K_EVERY) -> ScheduleKind.every
        rule.has(K_AT) -> ScheduleKind.at
        rule.has(K_DAILY) -> ScheduleKind.daily
        rule.has(K_WEEKLY) -> ScheduleKind.weekly
        rule.has(K_CRON) -> ScheduleKind.cron
        else -> null
    }

    fun zoneOf(rule: JSONObject): ZoneId {
        val tz = rule.optJSONObject(K_DAILY)?.optString(K_TZ)
            ?: rule.optJSONObject(K_WEEKLY)?.optString(K_TZ)
            ?: rule.optJSONObject(K_CRON)?.optString(K_TZ)
            ?: rule.optString(K_TZ)
        return parseZone(tz)
    }

    /* ------------------------------------------------------------------ */
    /* 下一次触发                                                          */
    /* ------------------------------------------------------------------ */

    /**
     * 从 fromMillis 之后（严格大于）算下一次触发。
     * 注意：解码/重启后**不要**用它覆盖已提交的 scheduledAt —— 只在创建、规则更新、
     * 周期任务推进时调用（桌面同此约定："重启绝不重算已提交的目标"）。
     */
    fun nextAfter(rule: JSONObject, fromMillis: Long): Long? {
        val zone = zoneOf(rule)
        val from = Instant.ofEpochMilli(fromMillis).atZone(zone)
        return when (kindOf(rule)) {
            ScheduleKind.after -> fromMillis + rule.optLong(K_AFTER) * 1000L
            ScheduleKind.every -> fromMillis + rule.optLong(K_EVERY) * 1000L
            ScheduleKind.at -> atMillis(rule.opt(K_AT))
            ScheduleKind.daily -> {
                val o = rule.optJSONObject(K_DAILY) ?: return null
                val time = parseTime(o.optString("time")) ?: return null
                dailyAfter(from, time, zone)
            }

            ScheduleKind.weekly -> {
                val o = rule.optJSONObject(K_WEEKLY) ?: return null
                val time = parseTime(o.optString("time")) ?: return null
                val days = parseWeekdays(o.optJSONArray("weekdays")).toSet()
                weeklyAfter(from, time, days, zone)
            }

            ScheduleKind.cron -> {
                val o = rule.optJSONObject(K_CRON) ?: return null
                val expr = runCatching { CronExpr.parse(o.optString("expression")) }.getOrNull()
                    ?: return null
                expr.next(from)?.toInstant()?.toEpochMilli()
            }

            null -> null
        }
    }

    private fun dailyAfter(from: ZonedDateTime, time: LocalTime, zone: ZoneId): Long? {
        var date = from.toLocalDate()
        repeat(370) {
            val z = resolve(LocalDateTime.of(date, time), zone)
            if (z != null && z.isAfter(from)) return z.toInstant().toEpochMilli()
            date = date.plusDays(1)
        }
        return null
    }

    private fun weeklyAfter(
        from: ZonedDateTime,
        time: LocalTime,
        days: Set<Int>,
        zone: ZoneId,
    ): Long? {
        var date = from.toLocalDate()
        repeat(370) {
            val iso = date.dayOfWeek.value   // 1=周一 … 7=周日
            if (iso in days) {
                val z = resolve(LocalDateTime.of(date, time), zone)
                if (z != null && z.isAfter(from)) return z.toInstant().toEpochMilli()
            }
            date = date.plusDays(1)
        }
        return null
    }

    /**
     * 解析一个本地时间到瞬间。
     * - DST 缺失（gap）→ 返回 null，调用方**跳过这一天**（与桌面一致，不是平移）
     * - DST 重叠（fold）→ `atZone` 取较早偏移（与桌面一致）
     */
    private fun resolve(ldt: LocalDateTime, zone: ZoneId): ZonedDateTime? =
        if (zone.rules.getValidOffsets(ldt).isEmpty()) null else ldt.atZone(zone)

    /* ------------------------------------------------------------------ */
    /* 小工具                                                              */
    /* ------------------------------------------------------------------ */

    fun formatIso(millis: Long, zone: ZoneId): String =
        Instant.ofEpochMilli(millis).atZone(zone).toString()

    private fun tzOf(o: JSONObject): String =
        o.optString(K_TZ).ifBlank { o.optString(K_TZ_LEGACY) }

    private fun parseZone(raw: String?): ZoneId {
        val t = raw?.trim().orEmpty()
        if (t.isEmpty()) return ZoneId.systemDefault()
        if (t.equals("UTC", true)) return ZoneId.of("UTC")
        return runCatching { ZoneId.of(t) }.getOrElse {
            throw ScheduleException.rule("无法识别时区「$t」；需要 IANA 名称如 Asia/Shanghai")
        }
    }

    fun parseTime(raw: String?): LocalTime? {
        val t = raw?.trim().orEmpty()
        if (t.isEmpty()) return null
        return runCatching { LocalTime.parse(t) }.getOrElse {
            // 容忍 HH:mm
            runCatching { LocalTime.parse(t, java.time.format.DateTimeFormatter.ofPattern("H:mm")) }
                .getOrNull()
        }
    }

    private fun fmtTime(t: LocalTime): String = String.format(
        java.util.Locale.ROOT, "%02d:%02d:%02d", t.hour, t.minute, t.second,
    )

    /** weekdays：非空、每项 1..7、去重升序 */
    private fun parseWeekdays(arr: JSONArray?): List<Int> {
        if (arr == null || arr.length() == 0) {
            throw ScheduleException.rule("weekly.weekdays 不能为空；ISO 星期 1=周一 … 7=周日")
        }
        val out = sortedSetOf<Int>()
        for (i in 0 until arr.length()) {
            val v = arr.optInt(i, Int.MIN_VALUE)
            if (v !in 1..7) {
                throw ScheduleException.rule("weekly.weekdays 只能是 1..7（收到 $v）")
            }
            out.add(v)
        }
        return out.toList()
    }

    /**
     * `at` → UTC 毫秒。接受：
     *   - 数字（老数据里已经是毫秒）
     *   - RFC3339 / 带时区 ISO 字符串
     *   - `{date, time, time_zone}` 对象
     */
    fun atMillis(value: Any?): Long? = when (value) {
        null, JSONObject.NULL -> null
        is Number -> value.toLong()
        is String -> {
            val s = value.trim()
            if (s.isEmpty()) null
            else runCatching { Instant.parse(s).toEpochMilli() }.getOrElse {
                runCatching { ZonedDateTime.parse(s).toInstant().toEpochMilli() }.getOrElse {
                    runCatching {
                        LocalDateTime.parse(s).atZone(ZoneId.systemDefault()).toInstant().toEpochMilli()
                    }.getOrNull()
                }
            }
        }

        is JSONObject -> {
            val date = value.optString("date")
            val time = value.optString("time")
            if (date.isBlank() || time.isBlank()) {
                null
            } else {
                runCatching {
                    val zone = parseZone(value.optString(K_TZ).ifBlank {
                        value.optString(K_TZ_LEGACY)
                    })
                    val t = parseTime(time) ?: return@runCatching null
                    LocalDateTime.of(LocalDate.parse(date), t).atZone(zone)
                        .toInstant().toEpochMilli()
                }.getOrNull()
            }
        }

        else -> null
    }

    /* ------------------------------------------------------------------ */
    /* 五字段 Vixie cron                                                    */
    /* ------------------------------------------------------------------ */

    /**
     * 预解析的 cron 表达式。原来的实现每次判断都把表达式的正则 split 一遍再逐分钟扫
     * （最坏 52 万次），`schedule_create` 用复杂表达式会卡住数秒。这里解析一次，
     * 之后按字段跳进（月→日→时→分），正常一周内就命中。
     */
    class CronExpr private constructor(
        private val minutes: BooleanArray,
        private val hours: BooleanArray,
        private val doms: BooleanArray,
        private val months: BooleanArray,
        private val dows: BooleanArray,
        private val domStar: Boolean,
        private val dowStar: Boolean,
        val canonical: String,
    ) {

        fun next(from: ZonedDateTime): ZonedDateTime? {
            val zone = from.zone
            var date: LocalDate = from.toLocalDate()
            var hour = from.hour
            var minute = from.minute + 1
            if (minute > 59) {
                minute = 0
                hour++
                if (hour > 23) {
                    hour = 0
                    date = date.plusDays(1)
                }
            }
            val limit = from.toLocalDate().plusYears(SEARCH_YEARS)
            while (!date.isAfter(limit)) {
                if (!months[date.monthValue]) {
                    date = LocalDate.of(date.year, date.monthValue, 1).plusMonths(1)
                    hour = 0
                    minute = 0
                    continue
                }
                if (!dayMatches(date)) {
                    date = date.plusDays(1)
                    hour = 0
                    minute = 0
                    continue
                }
                if (!hours[hour]) {
                    hour++
                    minute = 0
                    if (hour > 23) {
                        hour = 0
                        date = date.plusDays(1)
                    }
                    continue
                }
                if (!minutes[minute]) {
                    minute++
                    if (minute > 59) {
                        minute = 0
                        hour++
                        if (hour > 23) {
                            hour = 0
                            date = date.plusDays(1)
                        }
                    }
                    continue
                }
                val ldt = LocalDateTime.of(date, LocalTime.of(hour, minute))
                // DST gap：这个本地时间不存在 → 跳过（与桌面一致）
                if (zone.rules.getValidOffsets(ldt).isEmpty()) {
                    minute++
                    if (minute > 59) {
                        minute = 0
                        hour++
                        if (hour > 23) {
                            hour = 0
                            date = date.plusDays(1)
                        }
                    }
                    continue
                }
                return ldt.atZone(zone)
            }
            return null
        }

        /** Vixie：dom 或 dow 任一为星号 → 两者都匹配；都不是星号 → 匹配任一 */
        private fun dayMatches(date: LocalDate): Boolean {
            val domOk = doms[date.dayOfMonth]
            val dowOk = dows[cronDow(date.dayOfWeek)]
            return if (domStar || dowStar) domOk && dowOk else domOk || dowOk
        }

        companion object {
            private fun cronDow(d: DayOfWeek): Int = if (d == DayOfWeek.SUNDAY) 0 else d.value

            fun parse(expression: String?): CronExpr {
                val expr = expression?.trim().orEmpty()
                val f = expr.split(Regex("\\s+")).filter { it.isNotBlank() }
                if (f.size != 5) {
                    throw ScheduleException.rule(
                        "cron 必须是 5 个字段「分 时 日 月 周」（收到 ${f.size} 个：$expr）",
                    )
                }
                val minutes = field(f[0], 0, 59, "minute")
                val hours = field(f[1], 0, 23, "hour")
                val doms = field(f[2], 1, 31, "day-of-month")
                val months = field(f[3], 1, 12, "month")
                // 周日既接受 0 也接受 7
                val dowRaw = field(f[4], 0, 7, "day-of-week")
                val dows = BooleanArray(7)
                for (i in 0..6) dows[i] = dowRaw[i]
                if (dowRaw[7]) dows[0] = true
                val domStar = f[2].trim().startsWith("*")
                val dowStar = f[4].trim().startsWith("*")
                val canonical = listOf(
                    canonicalField(minutes, 0, 59),
                    canonicalField(hours, 0, 23),
                    canonicalField(doms, 1, 31),
                    canonicalField(months, 1, 12),
                    canonicalDow(dows),
                ).joinToString(" ")
                return CronExpr(minutes, hours, doms, months, dows, domStar, dowStar, canonical)
            }

            /** 单字段 → 布尔集合；拒绝 L/W/#/名称/反向区间/零步长 */
            private fun field(spec: String, min: Int, max: Int, name: String): BooleanArray {
                val set = BooleanArray(max + 1)
                for (rawPart in spec.split(",")) {
                    val part = rawPart.trim()
                    if (part.isEmpty()) throw ScheduleException.rule("cron 的 $name 字段有空项：$spec")
                    if (part.any { it.isLetter() }) {
                        throw ScheduleException.rule(
                            "cron 的 $name 字段不支持字母/`L`/`W`/`#`/`@`（收到「$part」）；" +
                                "只支持 * 、单个值、a-b 区间、*/n 与 a-b/n",
                        )
                    }
                    val step: Int
                    val body: String
                    if (part.contains("/")) {
                        val bits = part.split("/")
                        if (bits.size != 2) {
                            throw ScheduleException.rule("cron 的 $name 字段步长写法错误：「$part」")
                        }
                        body = bits[0].trim()
                        step = bits[1].trim().toIntOrNull()
                            ?: throw ScheduleException.rule("cron 的 $name 字段步长不是数字：「$part」")
                        if (step <= 0) {
                            throw ScheduleException.rule("cron 的 $name 字段步长必须 ≥1：「$part」")
                        }
                    } else {
                        body = part
                        step = 1
                    }
                    val lo: Int
                    val hi: Int
                    when {
                        body == "*" -> {
                            lo = min
                            hi = max
                        }

                        body.contains("-") -> {
                            val b = body.split("-")
                            if (b.size != 2) {
                                throw ScheduleException.rule("cron 的 $name 字段区间写法错误：「$part」")
                            }
                            lo = b[0].trim().toIntOrNull()
                                ?: throw ScheduleException.rule("cron 的 $name 字段不是数字：「$part」")
                            hi = b[1].trim().toIntOrNull()
                                ?: throw ScheduleException.rule("cron 的 $name 字段不是数字：「$part」")
                            if (lo > hi) {
                                throw ScheduleException.rule("cron 的 $name 字段区间反向：「$part」")
                            }
                        }

                        else -> {
                            lo = body.toIntOrNull()
                                ?: throw ScheduleException.rule("cron 的 $name 字段不是数字：「$part」")
                            hi = lo
                        }
                    }
                    if (lo < min || hi > max) {
                        throw ScheduleException.rule(
                            "cron 的 $name 字段超出范围 $min..$max：「$part」",
                        )
                    }
                    var v = lo
                    while (v <= hi) {
                        set[v] = true
                        v += step
                    }
                }
                return set
            }

            private fun canonicalField(values: BooleanArray, min: Int, max: Int): String {
                val nums = (min..max).filter { values[it] }
                if (nums.isEmpty()) throw ScheduleException.rule("cron 字段没有任何取值")
                if (nums.size == max - min + 1) return "*"
                if (nums.size == 1) return nums[0].toString()
                val step = nums[1] - nums[0]
                if (step > 1 && nums.indices.all { i -> nums[i] == nums[0] + step * i }) {
                    val last = nums.last()
                    if (nums[0] == min && last + step > max) return "*/$step"
                    if (last + step > max) return "${nums[0]}-$last/$step"
                }
                // 否则把连续值压成区间
                val sb = StringBuilder()
                var i = 0
                while (i < nums.size) {
                    var j = i
                    while (j + 1 < nums.size && nums[j + 1] == nums[j] + 1) j++
                    if (sb.isNotEmpty()) sb.append(',')
                    if (j == i) sb.append(nums[i]) else sb.append(nums[i]).append('-').append(nums[j])
                    i = j + 1
                }
                return sb.toString()
            }

            /** 周日统一写 0（桌面存储规范） */
            private fun canonicalDow(dows: BooleanArray): String {
                val full = (0..6).all { dows[it] }
                if (full) return "*"
                val nums = (0..6).filter { dows[it] }
                if (nums.size == 1) return nums[0].toString()
                val step = nums[1] - nums[0]
                if (step > 1 && nums.indices.all { i -> nums[i] == nums[0] + step * i }) {
                    val last = nums.last()
                    if (nums[0] == 0 && last + step > 6) return "*/$step"
                    if (last + step > 6) return "${nums[0]}-$last/$step"
                }
                val sb = StringBuilder()
                var i = 0
                while (i < nums.size) {
                    var j = i
                    while (j + 1 < nums.size && nums[j + 1] == nums[j] + 1) j++
                    if (sb.isNotEmpty()) sb.append(',')
                    if (j == i) sb.append(nums[i]) else sb.append(nums[i]).append('-').append(nums[j])
                    i = j + 1
                }
                return sb.toString()
            }
        }
    }
}
