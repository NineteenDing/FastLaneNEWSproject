// Broad AI discovery prefilter reused from the user-owned legacy bridge; not topic scoring.
// See REUSE.md for source fingerprint and scope.
export const AI_RE = /(人工智能|通用人工智能|大模型|大语言模型|语言模型|机器学习|深度学习|神经网络|强化学习|生成式|多模态|智能体|智能|算法|算力|芯片|半导体|机器人|具身|数字人|自动驾驶|智能驾驶|文生|图生|视频生成|图像生成|AIGC|LLM|agent|AGI|\bai\b|GPT|ChatGPT|Claude|Gemini|Llama|DeepSeek|Qwen|Kimi|MiniMax|可灵|即梦|海螺|豆包|文心|通义|混元|智谱|元宝|星火|Sora|Veo|Kling|Runway|diffusion|transformer|模型|开源)/i;

// Reuse the legacy keyword-discovery seam, with a narrower policy for public platform trends.
// A match authorizes fetching evidence; it does not verify the headline or authorize publication.
const FILM = /影像|视频|图像|图片|音乐|音频|影视|电影|短片|短剧|漫剧|漫画|动画|剧本|演员|配音|口型|分镜|镜头|角色控制|角色一致性|人物一致性|场景连续性|画面一致性|摄影|运镜|特效|观众|观影|作曲|声音克隆|数字人|video|image|music|audio|film|cinema|animation/i;
const AI = /\bai\b|aigc|人工智能|生成式|大模型|文生|图生|声生/i;
const FILM_TOOLS = /可灵|即梦|海螺|Kling|Sora|Veo\b|Runway|Midjourney|Stable Diffusion|ComfyUI|Suno\b|Udio\b|Seedance|Seedream|Wan\d|万相|混元视频|Vidu\b|PixVerse|Luma\b|Hailuo/i;
const GENERAL = /ChatGPT|GPT[-－]?\d|Claude|Gemini|DeepSeek|Qwen|千问|Kimi|MiniMax|豆包|智谱|大模型|人工智能|通用人工智能|AGI\b/i;
const CHANGE = /发布|上线|开放|开源|升级|新模型|突破|免费|涨价|降价|停服|故障|事故|泄露|版权|监管|法案|政策|禁令|争议|造假|安全|release|launch|open.weight|policy|incident/i;
export function classifyTrendTitle(title: string) {
  const direct = FILM_TOOLS.test(title) || AI.test(title) && FILM.test(title);
  const general = GENERAL.test(title) && CHANGE.test(title);
  return { relevant: direct || general, scope: direct ? "direct_ai_film" : general ? "general_ai" : "excluded",
    reason: direct ? "本地关键词命中AI影视、作品或观看体验；等待原文事实核验" : general
      ? "本地关键词命中重要通用AI变化；取得正文后按严格公开资格判断" : "未命中AI影视或重要通用AI变化关键词；不因热榜排名单独入库" };
}
