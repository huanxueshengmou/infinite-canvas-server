const field = (name, label, value, type = "text") => ({ name, label, value, type });
const request = (title, category, url, fields, body, poll) => ({
  title, category, note: "", fields,
  request: { url, method: "POST", header: "Authorization", apiKey: "", body: JSON.stringify(body, null, 2) },
  ...(poll ? { poll } : {}),
});

// Parameter layouts follow the user's ComfyUI-API-Nodes and ComfyUI-AutoDL-H3.
// Templates are inert configuration. No Python, JavaScript, GPU workload or credentials are imported.
export const builtInTemplates = [
  { id: "builtin-text", name: "自定义文本拼接", kind: "custom", outputType: "text", content: "{{input.text}}" },
  { id: "builtin-json", name: "自定义 JSON 数据", kind: "custom", outputType: "json", content: '{\n  "prompt": "{{input.text}}"\n}' },
  { id: "builtin-request", name: "自定义 API 请求", kind: "private", privateData: request("自定义请求", "request", "", [], { prompt: "{{input.text}}" }) },
  { id: "builtin-image", name: "ComfyUI · OpenAI 兼容生图", kind: "private", privateData: request("图片生成", "image", "https://api.openai.com/v1/images/generations", [
    field("model", "模型", "gpt-image-2"), field("prompt", "提示词（连线输入优先）", ""), field("size", "尺寸", "1280x720"), field("quality", "质量", "auto"),
  ], { model: "{{params.model}}", prompt: "{{input.text}}", size: "{{params.size}}", quality: "{{params.quality}}" }) },
  { id: "builtin-image-chat", name: "ComfyUI · 参考图对话请求", kind: "private", privateData: request("参考图请求", "image", "https://api.openai.com/v1/chat/completions", [
    field("model", "支持图片的模型", ""), field("prompt", "提示词（连线输入优先）", ""),
  ], { model: "{{params.model}}", messages: [{ role: "user", content: [{ type: "text", text: "{{input.text}}" }, { type: "image_url", image_url: { url: "{{image.dataUrl}}" } }] }] }) },
  { id: "builtin-llm", name: "ComfyUI · 提示词优化", kind: "private", privateData: request("提示词优化", "llm", "https://api.openai.com/v1/chat/completions", [
    field("model", "模型", ""), field("prompt", "原始提示词（连线输入优先）", ""), field("system", "系统指令", "请优化用户提供的生成提示词，保留原意，只返回优化后的提示词。"),
  ], { model: "{{params.model}}", messages: [{ role: "system", content: "{{params.system}}" }, { role: "user", content: "{{input.text}}" }] }) },
  { id: "builtin-video", name: "ComfyUI · AutoDL H3 视频", kind: "private", privateData: request("AutoDL H3 视频", "video", "https://autodl.art/api/v1/comfyui/comfyui_workflow/minimax_h3_image_audio_to_video_v2_15s", [
    field("prompt", "提示词（连线输入优先）", ""), field("duration", "时长（秒，按供应商支持范围填写）", 5, "number"), field("resolution", "分辨率", "768p横"),
  ], { prompt: "{{input.text}}", duration: "{{params.duration}}", resolution: "{{params.resolution}}", ref_image_0: "{{image.dataUrl?}}", ref_audio_0: "{{audio.dataUrl?}}" },
  { url: "https://autodl.art/api/v1/comfyui/comfyui_workflow/result/{{task.id}}", taskIdPath: "task_id|data.task_id|id|data.id" }) },
].map((template) => ({ content: "", outputType: "text", ...template, builtIn: true, version: 1 }));
