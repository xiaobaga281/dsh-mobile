package ai.deepseek.harness.mobile.kernel.plugin.builtin.device

import ai.deepseek.harness.mobile.kernel.KernelError
import ai.deepseek.harness.mobile.kernel.plugin.KernelPlugin
import ai.deepseek.harness.mobile.kernel.plugin.PluginContext
import ai.deepseek.harness.mobile.kernel.plugin.Schemas
import ai.deepseek.harness.mobile.kernel.plugin.SimpleTool
import ai.deepseek.harness.mobile.kernel.plugin.ToolSpec
import ai.deepseek.harness.mobile.kernel.plugin.pick
import ai.deepseek.harness.mobile.kernel.plugin.pickInt
import ai.deepseek.harness.mobile.kernel.plugin.pickLong
import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.provider.CalendarContract
import android.provider.ContactsContract
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/**
 * 个人数据插件：系统日历与通讯录。
 *
 * 三个工具都实现完整，但**故意不进任何内置档位**（Presets）——日程和联系人属于
 * 高敏个人数据，敏感度高于相册。想启用由用户在 files/kernel/presets.json 的
 * overrides 里手动加白，例如：
 *   {"overrides": {"standard": {"add": ["calendar_read", "calendar_create", "contacts_search"]}}}
 * 重启生效。三个运行时权限（日历读/写、联系人）在 Manifest 里声明，由系统权限面板授予。
 */
class PersonalDataPlugin : KernelPlugin {
    override val id = "personal-data"
    override val name = "日历与联系人"
    override val description = "系统日历查询/建日程、通讯录搜索（敏感：默认关闭，需在 presets.json overrides 手动启用）"
    override val version = "1.0.0"

    private var app: Context? = null
    private var reads = 0

    override fun onLoad(ctx: PluginContext) {
        app = ctx.service("app.context") as? Context
    }

    override fun onUnload() {
        app = null
    }

    override fun status(): Map<String, String> = mapOf(
        "查询次数" to reads.toString(),
        "启用状态" to "默认关闭（在 presets.json overrides 里加白后可用）",
    )

    private val c: Context
        get() = app ?: throw KernelError("个人数据插件未就绪（应用上下文缺失），重启应用后再试")

    private fun need(permission: String, what: String) {
        if (c.checkSelfPermission(permission) != PackageManager.PERMISSION_GRANTED) {
            throw KernelError("还没有${what}权限：请到系统设置 → 应用 → 权限，允许「${what}」后重试")
        }
    }

    private val fmt = SimpleDateFormat("yyyy-MM-dd HH:mm", Locale.getDefault())

    override val tools: List<ToolSpec> = listOf(
        SimpleTool(
            name = "calendar_read",
            description = "查询系统日历：未来 N 天的日程（时间、标题、地点、重复规则）。「我这周有什么安排」" +
                "「明天几点的会」用这个。需要日历权限，且该工具默认关闭（见插件说明）。",
            parameters = Schemas.params(
                mapOf(
                    "days_ahead" to Schemas.prop("number", "往后查几天，默认 7，上限 60"),
                    "query" to Schemas.prop("string", "按标题/地点模糊过滤"),
                    "limit" to Schemas.prop("number", "最多返回几条，默认 20，上限 50"),
                ),
                emptyList(),
            ),
        ) { a ->
            reads++
            need(Manifest.permission.READ_CALENDAR, "日历")
            val days = a.pickInt("days_ahead", "days", default = 7).coerceIn(1, 60)
            val q = a.pick("query")
            val limit = a.pickInt("limit", default = 20).coerceIn(1, 50)
            val now = System.currentTimeMillis()
            val end = now + days * 86_400_000L
            val uri = CalendarContract.Instances.CONTENT_URI.buildUpon()
                .appendPath(now.toString()).appendPath(end.toString()).build()
            val projection = arrayOf(
                CalendarContract.Instances.BEGIN,
                CalendarContract.Instances.END,
                CalendarContract.Instances.TITLE,
                CalendarContract.Instances.EVENT_LOCATION,
                CalendarContract.Instances.DESCRIPTION,
            )
            val out = ArrayList<String>()
            c.contentResolver.query(uri, projection, null, null, CalendarContract.Instances.BEGIN)
                ?.use { cur ->
                    while (cur.moveToNext() && out.size < limit) {
                        val title = cur.getString(2).orEmpty()
                        val where = cur.getString(3).orEmpty()
                        if (q.isNotBlank() && !title.contains(q) && !where.contains(q)) continue
                        val begin = cur.getLong(0)
                        val endMs = cur.getLong(1)
                        fmt.timeZone = TimeZone.getDefault()
                        val sameDay = SimpleDateFormat("yyyy-MM-dd", Locale.getDefault())
                            .format(Date(begin)) == SimpleDateFormat("yyyy-MM-dd", Locale.getDefault()).format(Date(endMs))
                        val timeRange = if (sameDay) {
                            "${fmt.format(Date(begin))} ~ " +
                                SimpleDateFormat("HH:mm", Locale.getDefault()).format(Date(endMs))
                        } else {
                            "${fmt.format(Date(begin))} ~ ${fmt.format(Date(endMs))}"
                        }
                        out.add("$timeRange | $title" +
                            (if (where.isNotBlank()) " @ $where" else ""))
                    }
                }
            if (out.isEmpty()) "未来 $days 天没有匹配的日程"
            else "未来 $days 天共 ${out.size} 条日程（时间 | 标题 @ 地点）：\n" + out.joinToString("\n")
        },

        SimpleTool(
            name = "calendar_create",
            description = "在系统日历里创建一个日程（会出现在系统日历/锁屏/穿戴提醒里）。「帮我约周五 3 点的会」" +
                "用这个。需要 begin_time（epoch 毫秒）+ title；duration_minutes 缺省按 60 分钟记。",
            parameters = Schemas.params(
                mapOf(
                    "title" to Schemas.prop("string", "日程标题"),
                    "begin_ms" to Schemas.prop("number", "开始时间（epoch 毫秒）。先算好再传，别猜相对时间"),
                    "duration_minutes" to Schemas.prop("number", "时长（分钟），默认 60"),
                    "location" to Schemas.prop("string", "地点"),
                    "description" to Schemas.prop("string", "备注"),
                ),
                listOf("title", "begin_ms"),
            ),
        ) { a ->
            need(Manifest.permission.WRITE_CALENDAR, "日历")
            val title = a.pick("title")
            val begin = a.pickLong("begin_ms", "begin", "start")
            if (begin <= 0) throw KernelError("begin_ms 必须是 epoch 毫秒（当前时间可用 device_info 附近的时间推算，别猜）")
            val durMin = a.pickInt("duration_minutes", default = 60).coerceIn(5, 60 * 24 * 7)
            val calId = primaryCalendarId()
                ?: throw KernelError("找不到可写的系统日历账户（设备上没有配置任何日历账户）")
            val cv = android.content.ContentValues().apply {
                put(CalendarContract.Events.CALENDAR_ID, calId)
                put(CalendarContract.Events.TITLE, title)
                put(CalendarContract.Events.DTSTART, begin)
                put(CalendarContract.Events.DTEND, begin + durMin * 60_000L)
                put(CalendarContract.Events.EVENT_TIMEZONE, TimeZone.getDefault().id)
                a.pick("location").takeIf { it.isNotBlank() }?.let { put(CalendarContract.Events.EVENT_LOCATION, it) }
                a.pick("description").takeIf { it.isNotBlank() }?.let { put(CalendarContract.Events.DESCRIPTION, it) }
            }
            val uri = c.contentResolver.insert(CalendarContract.Events.CONTENT_URI, cv)
                ?: throw KernelError("日历拒绝写入（账户被策略限制或参数不合法）")
            "已创建日程「$title」：${fmt.format(Date(begin))}，时长 ${durMin} 分钟" +
                (a.pick("location").takeIf { it.isNotBlank() }?.let { "，地点 $it" } ?: "")
        },

        SimpleTool(
            name = "contacts_search",
            description = "按名字搜通讯录，返回姓名+电话+邮箱。「给张三发消息」之前先用它拿到号码。" +
                "需要联系人权限，且该工具默认关闭（见插件说明）。",
            parameters = Schemas.params(
                mapOf(
                    "query" to Schemas.prop("string", "姓名关键字（支持拼音/汉字，取决于系统索引）"),
                    "limit" to Schemas.prop("number", "最多返回几条，默认 10，上限 30"),
                ),
                listOf("query"),
            ),
        ) { a ->
            need(Manifest.permission.READ_CONTACTS, "联系人")
            val q = a.pick("query")
            if (q.isBlank()) throw KernelError("query 不能为空：告诉我搜谁")
            val limit = a.pickInt("limit", default = 10).coerceIn(1, 30)
            val out = ArrayList<String>()
            // 先按名字过滤联系人 id，再逐个取电话/邮箱（ContactsContract 的经典两段式）
            val ids = LinkedHashMap<Long, String>()
            c.contentResolver.query(
                ContactsContract.Contacts.CONTENT_URI,
                arrayOf(ContactsContract.Contacts._ID, ContactsContract.Contacts.DISPLAY_NAME),
                "${ContactsContract.Contacts.DISPLAY_NAME} LIKE ?",
                arrayOf("%$q%"),
                ContactsContract.Contacts.DISPLAY_NAME,
            )?.use { cur ->
                while (cur.moveToNext() && ids.size < limit) {
                    ids[cur.getLong(0)] = cur.getString(1).orEmpty()
                }
            }
            for ((id, name) in ids) {
                val phones = ArrayList<String>()
                c.contentResolver.query(
                    ContactsContract.CommonDataKinds.Phone.CONTENT_URI,
                    arrayOf(ContactsContract.CommonDataKinds.Phone.NUMBER),
                    "${ContactsContract.CommonDataKinds.Phone.CONTACT_ID} = ?",
                    arrayOf(id.toString()), null,
                )?.use { cur -> while (cur.moveToNext()) phones.add(cur.getString(0).orEmpty()) }
                val emails = ArrayList<String>()
                c.contentResolver.query(
                    ContactsContract.CommonDataKinds.Email.CONTENT_URI,
                    arrayOf(ContactsContract.CommonDataKinds.Email.ADDRESS),
                    "${ContactsContract.CommonDataKinds.Email.CONTACT_ID} = ?",
                    arrayOf(id.toString()), null,
                )?.use { cur -> while (cur.moveToNext()) emails.add(cur.getString(0).orEmpty()) }
                val contact = listOfNotNull(
                    name,
                    phones.take(2).joinToString("/").takeIf { it.isNotBlank() },
                    emails.take(1).joinToString("/").takeIf { it.isNotBlank() },
                ).joinToString(" · ")
                out.add(contact)
            }
            if (out.isEmpty()) "通讯录里没有匹配「$q」的联系人"
            else "找到 ${out.size} 个联系人：\n" + out.joinToString("\n")
        },
    )

    /** 找第一个可写的日历账户 id */
    private fun primaryCalendarId(): Long? {
        val proj = arrayOf(
            CalendarContract.Calendars._ID,
            CalendarContract.Calendars.CALENDAR_ACCESS_LEVEL,
        )
        c.contentResolver.query(
            CalendarContract.Calendars.CONTENT_URI, proj, null, null, null,
        )?.use { cur ->
            while (cur.moveToNext()) {
                val id = cur.getLong(0)
                val access = cur.getInt(1)
                if (access >= CalendarContract.Calendars.CAL_ACCESS_CONTRIBUTOR) return id
            }
        }
        return null
    }
}
