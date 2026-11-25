package ai.deepseek.harness.mobile.kernel

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 生成端点契约学习器（GenProbe.VideoContractLearner）—— 用 agnes 真实端点的错误样本钉住。
 *
 * 错误驱动的探测依赖端点校验错误的三种形态（均为 2026-10-31 实抓原文）：
 *   ① mode 必填：{"code":"invalid_request","message":"mode is required ...","data":{"param":"mode"}}
 *   ② 候选不合法：{"code":"invalid_request","message":"invalid mode ...","data":{"param":"mode"}}
 *   ③ size 白名单直给：{"code":"invalid_request","message":"size must be one of 720P ...",
 *      "data":{"param":"size","valid_sizes":["720P"]}}
 * 学习器必须从这三种形态学出 {modes:[text,reference], modeRequired:true, sizes:[720P]}。
 */
class GenProbeLearnerTest {

    private val modeRequired = """{"code":"invalid_request","message":"mode is required (request id: x)","data":{"param":"mode"}}"""
    private val invalidMode = """{"code":"invalid_request","message":"invalid mode (request id: x)","data":{"param":"mode"}}"""
    private val sizeWhitelist = """{"code":"invalid_request","message":"size must be one of 720P (request id: x)","data":{"param":"size","valid_sizes":["720P"]}}"""

    @Test
    fun `agnes 契约 - 基线暴露 mode 必填 候选试出 text 与 reference`() {
        val l = GenProbe.VideoContractLearner("agnes-video-2.5-flash")
        l.baseline(GenProbe.Err(modeRequired))
        assertTrue("基线应标记 mode 必填", l.modeRequired)

        // size 非法探针让每个候选都被 size 校验拒绝（不会真的创建任务）
        val sizeReject = GenProbe.Err(sizeWhitelist)
        for (c in listOf("bogus", "text2video", "image2video")) {
            l.modeCandidate(c, GenProbe.Err(invalidMode))
        }
        assertTrue("text 合法", l.modeCandidate("text", GenProbe.Err(sizeWhitelist)))
        assertTrue("reference 合法", l.modeCandidate("reference", GenProbe.Err(sizeWhitelist)))

        val c = l.contract()
        assertEquals(listOf("text", "reference"), c.modes)
        assertTrue(c.modeRequired)
        assertEquals(listOf("720P"), c.sizes)
    }

    @Test
    fun `size 白名单从任何一步的 valid_sizes 收集`() {
        val l = GenProbe.VideoContractLearner("m")
        l.baseline(GenProbe.Err(sizeWhitelist))
        assertEquals(listOf("720P"), l.contract().sizes)
    }

    @Test
    fun `reference 模式缺 images 的错误不影响契约`() {
        val l = GenProbe.VideoContractLearner("m")
        val refNeedsImages = """{"code":"invalid_request","message":"reference mode requires images, audios, or videos (request id: x)","data":{"param":"images"}}"""
        l.baseline(GenProbe.Err(modeRequired))
        assertTrue("reference 通过 mode 校验", l.modeCandidate("reference", GenProbe.Err(refNeedsImages)))
        assertEquals(listOf("reference"), l.contract().modes)
    }

    @Test
    fun `端点直接给出合法 mode 列表时按列表收录并去重`() {
        val listed = """{"message":"invalid mode","data":{"param":"mode","valid_modes":["text","reference"]}}"""
        val l = GenProbe.VideoContractLearner("m")
        l.baseline(GenProbe.Err(listed))
        assertEquals(listOf("text", "reference"), l.contract().modes)
        // 候选再试到同值时不能重复
        l.modeCandidate("text", GenProbe.Err(sizeWhitelist))
        assertEquals(listOf("text", "reference"), l.contract().modes)
    }

    @Test
    fun `message 里的 valid modes 也能学出来`() {
        val l = GenProbe.VideoContractLearner("m")
        l.baseline(
            GenProbe.Err("""{"message":"invalid mode; valid modes: text, reference","data":{"param":"mode"}}"""),
        )
        assertEquals(listOf("text", "reference"), l.contract().modes)
    }

    @Test
    fun `traces 记录探测轨迹供诊断`() {
        val l = GenProbe.VideoContractLearner("m")
        l.baseline(GenProbe.Err(modeRequired))
        l.modeCandidate("text2video", GenProbe.Err(invalidMode))
        assertTrue(l.traces.isNotEmpty())
        assertTrue(l.contract().traces.isNotEmpty())
    }
}
