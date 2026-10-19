import { describe, expect, test } from "bun:test";
import { attachCreationTaskContexts, reconcileCreationTaskMessages } from "../src/pages/create/creation-conversations";
import type { CreationConversation, CreationMessage } from "../src/pages/create/creation-types";
import { pendingCreationTaskIds } from "../src/services/creation-conversation-store";
import type { GenerationTask } from "../src/services/api/task-center";
import * as runtime from "../src/pages/create/creation-runtime";

const createdAt = "2026-10-18T14:06:00.000Z";
const completedAt = "2026-10-18T14:12:00.000Z";

function conversation(message: Partial<CreationMessage> = {}): CreationConversation[] {
    return [
        {
            id: "conversation-1",
            title: "茶山视频",
            updatedAt: createdAt,
            messages: [
                { id: "prompt-1", role: "user", mode: "video", content: "茶山的电影镜头", createdAt },
                { id: "message-1", role: "assistant", mode: "video", content: "生成失败", createdAt, status: "error", error: "网络异常。", generationErrorCode: "network_error", taskIds: ["task-1"], ...message },
            ],
        },
    ];
}

function task(overrides: Partial<GenerationTask> = {}): GenerationTask & { creationResultStorageKeys?: string[] } {
    return { id: "task-1", type: "canvas_video", status: "succeeded", prompt: "茶山的电影镜头", attempts: 1, createdAt, updatedAt: completedAt, ...overrides };
}

describe("creation media task recovery", () => {
    test("an errored video remains observable and recovers the original successful task using its stable resource", () => {
        const before = conversation();
        expect(pendingCreationTaskIds(before)).toEqual(["task-1"]);
        const tasks = attachCreationTaskContexts([task()], before).map((item) => ({ ...item, creationResultStorageKeys: ["resource:video-1"] }));
        const after = reconcileCreationTaskMessages(runtime, before, tasks);
        expect(after[0].messages[1]).toMatchObject({ status: "done", content: "视频已生成", resultStorageKeys: ["resource:video-1"], taskIds: ["task-1"], createdAt });
        expect(after[0].messages[1].error).toBeUndefined();
        expect(after[0].messages[1].generationErrorCode).toBeUndefined();
        expect(after[0].updatedAt).toBe(completedAt);
        expect(pendingCreationTaskIds(after)).toEqual([]);
        expect(before[0].messages[1].status).toBe("error");
    });

    test("a pending message with attached results clears stale failure metadata when the task succeeds", () => {
        const before = conversation({ status: "pending", resultStorageKeys: ["resource:video-1"], generationEffectKeys: ["attached-once"] });
        const tasks = [{ ...task(), creationResultStorageKeys: ["resource:video-1"] }];
        const after = reconcileCreationTaskMessages(runtime, before, tasks);
        expect(after[0].messages[1].status).toBe("done");
        expect(after[0].messages[1].error).toBeUndefined();
        expect(after[0].messages[1].generationErrorCode).toBeUndefined();
        expect(after[0].messages[1].generationEffectKeys).toEqual(["attached-once"]);
        expect(reconcileCreationTaskMessages(runtime, after, tasks)).toBe(after);
    });

    test("server failure remains a failure rather than becoming a successful result", () => {
        const after = reconcileCreationTaskMessages(runtime, conversation(), [task({ status: "failed", error: "余额不足", errorCode: "insufficient_balance" })]);
        expect(after[0].messages[1]).toMatchObject({ status: "error", error: "余额不足" });
        expect(after[0].messages[1].resultStorageKeys).toBeUndefined();
    });

    test.each(["done", "cancelled"] as const)("does not overwrite an already %s message", (status) => {
        const before = conversation({ status, error: undefined, generationErrorCode: undefined });
        expect(reconcileCreationTaskMessages(runtime, before, [{ ...task(), creationResultStorageKeys: ["resource:video-1"] }])).toBe(before);
        expect(pendingCreationTaskIds(before)).toEqual([]);
    });

    test("an image batch waits for all tasks and preserves output order with partial failure", () => {
        const before = conversation({ mode: "image", taskIds: ["task-1", "task-2"] });
        const tasks = attachCreationTaskContexts([task({ type: "canvas_image" }), task({ id: "task-2", type: "canvas_image", status: "failed", error: "模型服务拒绝了请求" })], before);
        const first = { ...tasks[0], creationResultStorageKeys: ["resource:image-1"] };
        expect(reconcileCreationTaskMessages(runtime, before, [first])).toBe(before);
        const after = reconcileCreationTaskMessages(runtime, before, [tasks[1], first]);
        expect(after[0].messages[1]).toMatchObject({ status: "done", content: "1 张图片已生成，1 张失败", resultStorageKeys: ["resource:image-1"], taskIds: ["task-1", "task-2"] });
        expect(after[0].messages[1].error).toBeUndefined();
    });
});
