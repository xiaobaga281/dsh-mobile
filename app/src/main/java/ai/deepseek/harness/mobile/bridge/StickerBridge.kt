package ai.deepseek.harness.mobile.bridge

import android.webkit.JavascriptInterface
import org.json.JSONObject

/**
 * 表情包域：加号面板的表情选择器、图片转表情、发送与收藏都走这里。
 * 数据存在 `files/kernel/stickers.json`（应用私有目录，卸载即删），
 * Agent 侧通过内核 sticker.* 工具读写同一份仓库。
 *
 * 方法名统一带 `sticker` 前缀：`Native` 是把十个命名空间合成一个 Proxy 的，
 * 裸名 `list/save/remove` 会和别的域撞车（谁先注册谁赢），而且前端本来就是按
 * `stickerList/stickerSave` 调的——这里对齐调用侧，不是反过来改前端。
 */
class StickerBridge(private val core: BridgeCore) {

    private val store get() = core.stickerStore

    @JavascriptInterface
    fun stickerList(): String {
        val items = store?.list() ?: org.json.JSONArray()
        val out = org.json.JSONArray()
        for (i in 0 until items.length()) {
            val it = items.optJSONObject(i) ?: continue
            out.put(
                JSONObject().apply {
                    put("id", it.optString("id"))
                    put("name", it.optString("name"))
                    put("kind", it.optString("kind", "static"))
                    put("mime", it.optString("mime", "image/png"))
                    put("dataUrl", it.optString("dataUrl"))
                    put("w", it.optInt("w"))
                    put("h", it.optInt("h"))
                    put("uses", it.optInt("uses"))
                    put("by", it.optString("by"))
                    put("lastUsedAt", it.optLong("lastUsedAt"))
                    put("order", it.optInt("order", -1))
                },
            )
        }
        return out.toString()
    }

    /** 保存一个表情包（用户发的或从相册转的） */
    @JavascriptInterface
    fun stickerSave(id: String, name: String, kind: String, mime: String, dataUrl: String, w: Int, h: Int): String {
        val st = store ?: return "{\"ok\":false,\"error\":\"表情包仓库未就绪\"}"
        val entry = JSONObject().apply {
            put("id", id.ifBlank { "s-" + System.currentTimeMillis().toString(36) })
            put("name", name.ifBlank { "表情" })
            put("kind", if (kind == "gif") "gif" else "static")
            put("mime", mime.ifBlank { "image/png" })
            put("dataUrl", dataUrl)
            put("w", w)
            put("h", h)
            put("by", "user")
            put("uses", 1)
            put("lastUsedAt", System.currentTimeMillis())
        }
        return JSONObject().put("ok", true).put("id", st.add(entry).optString("id")).toString()
    }

    @JavascriptInterface
    fun stickerBump(id: String): String {
        val hit = store?.bump(id) ?: return "{\"ok\":false}"
        return JSONObject().put("ok", true).put("id", hit.optString("id")).toString()
    }

    @JavascriptInterface
    fun stickerRemove(id: String): String =
        JSONObject().put("ok", store?.remove(id) == true).toString()

    /** 长按拖动排序后的落库：按前端 DOM 里的先后顺序传 id 数组 */
    @JavascriptInterface
    fun stickerReorder(idsJson: String): String {
        val st = store ?: return "{\"ok\":false}"
        val ids = ArrayList<String>()
        runCatching {
            val arr = org.json.JSONArray(idsJson)
            for (i in 0 until arr.length()) {
                val id = arr.optString(i)
                if (id.isNotBlank()) ids.add(id)
            }
        }
        return JSONObject().put("ok", st.reorder(ids)).toString()
    }
}
