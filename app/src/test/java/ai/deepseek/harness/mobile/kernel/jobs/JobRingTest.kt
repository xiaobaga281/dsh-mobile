package ai.deepseek.harness.mobile.kernel.jobs

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 后台任务输出环的 JVM 验收。
 *
 * 对应修掉的缺陷：旧实现只有一个 `StringBuilder` + `output().take(12_000)`，
 * 模型拿到的是"最后 64KB 里的头部 12k" —— 既不是最新输出也不是开头，且无法增量读。
 * 现在按绝对偏移 + lossy 标记，读过的位置不会丢。
 */
class JobRingTest {

    private fun job() = JobRegistry.Job(id = "j1", name = "test", owner = "sess-1", startedAt = 0L)

    @Test
    fun `写入后可从头读到全部内容`() {
        val j = job()
        j.append("hello ")
        j.append("world")
        assertEquals(11, j.length())
        val r = j.readAt(0)
        assertEquals("hello world", r.text)
        assertEquals(0, r.from)
        assertEquals(11, r.next)
        assertFalse(r.lossy)
    }

    @Test
    fun `非消耗式读同一偏移结果稳定`() {
        val j = job()
        j.append("abcdef")
        val a = j.readAt(2)
        val b = j.readAt(2)
        assertEquals("cdef", a.text)
        assertEquals(a.text, b.text)
        assertFalse(a.lossy)
    }

    @Test
    fun `增量读只返回新增部分`() {
        val j = job()
        j.append("第一段")
        val first = j.readAt(0)
        j.append("第二段")
        val second = j.readAt(first.next)

        assertEquals("第一段", first.text)
        assertEquals("第二段", second.text)
        assertEquals(second.next, j.length())
    }

    @Test
    fun `超出保留窗口的读返回 lossy 而不是假装没输出`() {
        val j = job()
        // 超过运行期保留量，触发环形裁剪
        val big = "x".repeat(JobRegistry.RETAIN_CHARS + 1_000)
        j.append(big)

        assertEquals(JobRegistry.RETAIN_CHARS, j.retainedChars())
        assertTrue("裁剪过就必须承认", j.droppedChars() > 0)

        val fromZero = j.readAt(0)
        assertTrue("从 0 读已被丢弃 → lossy", fromZero.lossy)

        val fromTail = j.readAt(j.length() - 10)
        assertFalse("从现存结尾读不应标记 lossy", fromTail.lossy)
        assertEquals(10, fromTail.text.length)
    }

    @Test
    fun `消耗式读推进游标且不重复返回`() {
        val j = job()
        j.append("aaa")
        val first = j.readConsuming()
        assertEquals("aaa", first.text)
        assertEquals(3, j.cursor)

        j.append("bbb")
        val second = j.readConsuming()
        assertEquals("bbb", second.text)
        assertEquals(6, j.cursor)

        val third = j.readConsuming()
        assertEquals("没有新内容时返回空串", "", third.text)
    }

    @Test
    fun `结算后裁剪但绝不吃掉未消费的内容`() {
        val j = job()
        val big = "y".repeat(JobRegistry.SETTLED_RETAIN_CHARS * 2)
        j.append(big)
        val total = j.length()

        // 全部消费掉，游标推到末尾
        j.readConsuming()
        j.trimAfterSettle()

        assertEquals(
            "全部内容都已消费 → 可以裁到结算保留量",
            JobRegistry.SETTLED_RETAIN_CHARS,
            j.retainedChars(),
        )
        assertTrue("保留量应当收缩", total > j.retainedChars())
        // 关键不变量：裁剪只移动 dropped、不改变绝对长度。
        // length() 是「会话开始以来的总字符数」，模型手里的 offset 全靠它保持连续；
        // 它一旦倒退，上次返回的 next_offset 就会指到别的内容上。
        assertEquals("绝对长度不能倒退，否则 offset 语义断裂", total, j.length())
    }

    @Test
    fun `未消费的内容在结算裁剪后仍然读得到`() {
        val j = job()
        val big = "z".repeat(JobRegistry.SETTLED_RETAIN_CHARS * 3)
        j.append(big)
        val before = j.readAt(0)
        assertEquals(big.length, before.text.length)

        // 从未消费：游标还在 0，裁剪必须保留全部
        j.trimAfterSettle()
        assertEquals("未消费的内容不能被裁掉", big.length, j.retainedChars())

        val after = j.readAt(0)
        assertEquals(big.length, after.text.length)
    }

    @Test
    fun `truncatedBefore 如实反映偏移是否已丢`() {
        val j = job()
        j.append("x".repeat(JobRegistry.RETAIN_CHARS + 500))
        val dropped = j.droppedChars()
        assertTrue(dropped > 0)
        assertTrue(j.truncatedBefore(0))
        assertTrue(j.truncatedBefore(dropped - 1))
        assertFalse(j.truncatedBefore(dropped + 5))
    }

    @Test
    fun `ReadResult 序列化字段齐全`() {
        val j = job()
        j.append("abc")
        val json = j.readAt(0).toJson()
        assertEquals("abc", json.optString("output"))
        assertEquals(0, json.optInt("offset"))
        assertEquals(3, json.optInt("next_offset"))
        assertFalse(json.optBoolean("lossy"))
        assertEquals(3, json.optInt("chars"))
    }

    @Test
    fun `空任务读到空串而不是异常`() {
        val j = job()
        val r = j.readAt(0)
        assertEquals("", r.text)
        assertEquals(0, r.next)
        assertFalse(r.lossy)
    }
}
