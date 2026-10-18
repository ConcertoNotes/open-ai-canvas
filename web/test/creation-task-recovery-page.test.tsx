import { expect, test } from "bun:test";
import type { CreationConversation, CreationMessage } from "../src/pages/create/creation-types";
import type { GenerationTask } from "../src/services/api/task-center";

// Keep browser feature detection and Bun module replacements out of other suites.
if (!process.env.CREATION_RECOVERY_PAGE_CHILD) {
    test("真实创作页恢复任务、完整批次与稳定视频结果", () => {
        const result = Bun.spawnSync([process.execPath, "test", import.meta.path], {
            cwd: `${import.meta.dir}/..`,
            env: { ...process.env, CREATION_RECOVERY_PAGE_CHILD: "1" },
            timeout: 20000,
        });
        const output = new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr);
        if (result.exitCode !== 0) throw new Error(output);
        expect(output).toContain("5 pass");
        expect(output).toContain("0 fail");
    }, 30000);
} else {
    const { afterAll, mock } = await import("bun:test");
    const { Window } = await import("happy-dom");
    const dom = new Window({ url: "http://localhost/create" });
    const originals = new Map<string, PropertyDescriptor | undefined>();
    for (const [key, value] of Object.entries({
        window: dom, document: dom.document, navigator: dom.navigator,
        HTMLElement: dom.HTMLElement, Element: dom.Element, Node: dom.Node,
        SVGElement: dom.SVGElement, getComputedStyle: dom.getComputedStyle.bind(dom),
        IS_REACT_ACT_ENVIRONMENT: true,
    })) {
        originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
        Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    }

    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { create } = await import("zustand");
    const storage = new Map<string, string>();
    const memoryStorage = {
        getItem: async (key: string) => storage.get(key) ?? null,
        setItem: async (key: string, value: string) => { storage.set(key, value); },
        removeItem: async (key: string) => { storage.delete(key); },
    };
    mock.module("@/lib/localforage-storage", () => ({ localForageStorageForScope: () => memoryStorage, localForageStorage: memoryStorage }));
    const useAssetStore = create(() => ({ assets: [], addAsset: () => { throw new Error("unexpected asset creation"); } }));
    mock.module("@/stores/use-asset-store", () => ({ useAssetStore }));
    mock.module("@/services/user-data-sync", () => ({
        loadAssetsForUse: async () => {}, saveRemoteUserDataNow: async () => {}, hasRemoteUserDataSyncSession: () => false,
    }));
    mock.module("@/services/creation-canvas-conversation", () => ({ continueCreationConversationOnCanvas: async () => { throw new Error("unexpected canvas handoff"); } }));
    let composer: { setPrompt: (value: string) => void; onSubmit: () => void };
    // Presentation is outside this effect regression; messages expose the real page state.
    mock.module("@/pages/create/creation-workspace", () => ({
        CreationComposer: (props: typeof composer) => { composer = props; return null; }, CreationEmptySuggest: () => null, CreationHistoryDrawer: () => null,
        CreationModeTabs: () => null, CreationWorkspaceToolbar: () => null, creationAssetCategoryLabels: {},
        CreationMessageView: ({ item }: { item: CreationMessage }) => <pre data-message-id={item.id}>{JSON.stringify(item)}</pre>,
    }));
    mock.module("@/pages/create/creation-recent-canvases", () => ({ CreationRecentCanvases: () => null }));
    mock.module("@/pages/create/creation-agent-entry", () => ({ CreationAgentEntry: () => null }));
    mock.module("@/pages/create/creation-login-dialog", () => ({ CreationLoginDialog: () => null }));

    const lifecycle = await import("../src/services/generation-consumer-lifecycle");
    const dedupe = await import("../src/services/generation-consumer-dedupe");
    const assetSync = await import("../src/services/project-asset-sync");
    const observers = new Set<{ ids: string[]; receive: (task: GenerationTask) => void }>();
    let attachmentAlreadyApplied = false;
    let backendVideoUrl = "";
    const materialize = async (task: GenerationTask) => ({ ...task, outputs: task.outputs?.map((output) => ({ ...output, materializedAssetId: `asset-${task.id}` })) });
    mock.module("@/pages/create/creation-runtime", () => ({
        ...lifecycle, ...dedupe,
        generationTaskMaterializedUrls: assetSync.generationTaskMaterializedUrls,
        generationTaskMaterializedStorageKeys: assetSync.generationTaskMaterializedStorageKeys,
        materializeGenerationTaskAssets: materialize,
        projectGenerationTaskResult: assetSync.projectGenerationTaskResult,
        runGenerationOperationOnce: (_id: string | undefined, operation: () => Promise<unknown>) => operation(),
        isGenerationTaskCancelled: (_error: unknown, signal?: AbortSignal) => signal?.aborted === true,
        skillRuntime: { prepare: async ({ prompt }: { prompt: string }) => ({ prompt, metadata: {} }) },
        runBackendGenerationTask: async ({ onTaskUpdate }: { onTaskUpdate: (task: GenerationTask) => void }) => {
            onTaskUpdate(succeeded("submitted-task", "canvas_video", "resource:submitted-video"));
            return { video: { dataUrl: backendVideoUrl, storageKey: "resource:submitted-video" } };
        },
        consumeGenerationTaskMessage: (task: GenerationTask, messageId: string, consumer: Parameters<typeof assetSync.consumeGenerationTaskMessage>[2], dependencies: Parameters<typeof assetSync.consumeGenerationTaskMessage>[3] = {}) =>
            assetSync.consumeGenerationTaskMessage(task, messageId, consumer, {
                ...dependencies,
                materialize: dependencies.materialize ?? materialize,
                // Replace the persistent attach transaction, keeping the production consumer and callback.
                attachMessage: async (value, id, index, attach) => {
                    if (attachmentAlreadyApplied) return "completed" as const;
                    await attach({ task: value, effectKey: `message:${value.id}:${id}:${index}`, signal: dependencies.signal });
                    return "applied" as const;
                },
            }),
        subscribeGenerationTasks: (ids: string[], receive: (task: GenerationTask) => void) => {
            const observer = { ids, receive };
            observers.add(observer);
            return () => { observers.delete(observer); };
        },
    }));
    const { App } = await import("antd");
    const { MemoryRouter } = await import("react-router");
    const { useUserStore } = await import("../src/stores/use-user-store");
    const { useConfigStore, defaultConfig, createModelChannel, encodeChannelModel } = await import("../src/stores/use-config-store");
    const { useCreationPreferencesStore } = await import("../src/stores/use-creation-preferences-store");
    const { default: CreatePage } = await import("../src/pages/create");
    const { CREATION_CONVERSATIONS_KEY } = await import("../src/services/creation-conversation-store");
    useUserStore.setState({ hydrated: true });

    afterAll(() => {
        dom.happyDOM.abort();
        for (const [key, value] of originals) {
            if (value) Object.defineProperty(globalThis, key, value);
            else Reflect.deleteProperty(globalThis, key);
        }
    });

    const createdAt = "2026-10-18T14:06:00.000Z";
    const completedAt = "2026-10-18T14:12:00.000Z";
    function conversation(mode: "image" | "video", status: "pending" | "error", taskIds: string[]): CreationConversation {
        return {
            id: "conversation-1", title: "恢复测试", updatedAt: createdAt,
            messages: [
                { id: "prompt-1", role: "user", mode, content: "茶山的电影镜头", createdAt },
                { id: "message-1", role: "assistant", mode, content: status === "error" ? "生成失败" : "", status, taskIds, createdAt,
                    ...(status === "error" ? { error: "网络异常。", generationErrorCode: "network_error" } : {}) },
            ],
        };
    }
    function succeeded(id: string, type: "canvas_image" | "canvas_video", storageKey: string): GenerationTask {
        return {
            id, type, status: "succeeded", prompt: "茶山的电影镜头", attempts: 1, createdAt, updatedAt: completedAt,
            outputs: [{ outputIndex: 0, mediaType: type === "canvas_video" ? "video" : "image", materializedAssetId: `asset-${id}`, providerArtifactRef: storageKey }],
        };
    }
    async function fixture(initial: CreationConversation, alreadyAttached = false) {
        attachmentAlreadyApplied = alreadyAttached;
        storage.set(CREATION_CONVERSATIONS_KEY, JSON.stringify([initial]));
        const host = document.createElement("div");
        document.body.append(host);
        const errors: unknown[] = [];
        const root = createRoot(host, { onUncaughtError: (error) => errors.push(error) });
        await act(async () => { root.render(<App><MemoryRouter><CreatePage /></MemoryRouter></App>); });
        expect(errors).toEqual([]);
        expect(observers.size).toBe(initial.messages.some((item) => item.taskIds?.length) ? 1 : 0);
        return {
            message: () => JSON.parse(host.querySelector('[data-message-id="message-1"]')!.textContent!) as CreationMessage,
            latestMessage: () => JSON.parse([...host.querySelectorAll("[data-message-id]")].at(-1)!.textContent!) as CreationMessage,
            persisted: () => (JSON.parse(storage.get(CREATION_CONVERSATIONS_KEY)!) as CreationConversation[])[0],
            push: async (task: GenerationTask) => {
                await act(async () => { for (const observer of observers) if (observer.ids.includes(task.id)) observer.receive(task); });
                expect(errors).toEqual([]);
            },
            dispose: async () => { await act(async () => root.unmount()); host.remove(); },
        };
    }

    test("真实恢复 effect 挂载稳定视频资源后清除网络错误，并持久化成功状态", async () => {
        const page = await fixture(conversation("video", "error", ["task-1"]));
        try {
            await page.push(succeeded("task-1", "canvas_video", "resource:video-1"));
            expect(page.message()).toMatchObject({ status: "done", content: "视频已生成", resultStorageKeys: ["resource:video-1"], taskIds: ["task-1"] });
            expect(page.message().error).toBeUndefined();
            expect(page.message().generationErrorCode).toBeUndefined();
            expect(page.persisted().messages[1]).toMatchObject({ status: "done", content: "视频已生成", resultStorageKeys: ["resource:video-1"] });
            expect(page.persisted().messages[1].error).toBeUndefined();
        } finally { await page.dispose(); }
    });

    test("真实恢复 effect 等待分开发送的图片批次，并保存全部有序结果", async () => {
        const page = await fixture(conversation("image", "pending", ["task-1", "task-2"]));
        try {
            await page.push(succeeded("task-2", "canvas_image", "resource:image-2"));
            expect(page.message().status).toBe("pending");
            await page.push(succeeded("task-1", "canvas_image", "resource:image-1"));
            expect(page.message()).toMatchObject({ status: "done", content: "图片已生成", resultStorageKeys: ["resource:image-1", "resource:image-2"], taskIds: ["task-1", "task-2"] });
            expect(page.persisted().messages[1].resultStorageKeys).toEqual(["resource:image-1", "resource:image-2"]);
        } finally { await page.dispose(); }
    });

    test("附件已幂等挂载而未执行回调时，真实恢复 effect 仍收敛为成功", async () => {
        const page = await fixture(conversation("video", "error", ["task-1"]), true);
        try {
            await page.push(succeeded("task-1", "canvas_video", "resource:video-1"));
            expect(page.message()).toMatchObject({ status: "done", content: "视频已生成", resultStorageKeys: ["resource:video-1"] });
            expect(page.message().error).toBeUndefined();
            expect(page.message().generationErrorCode).toBeUndefined();
        } finally { await page.dispose(); }
    });

    test.each(["", "https://preview.invalid/video.mp4"])("主动提交视频的稳定资源足以完成消息（原始预览=%s）", async (preview) => {
        backendVideoUrl = preview;
        useUserStore.setState({ user: { id: "test-user", username: "test", displayName: "test", role: "user", status: "active" } });
        const channel = createModelChannel({ id: "test-channel", models: ["grok-imagine-video"], baseUrl: "https://model.invalid", apiKey: "test" });
        useConfigStore.getState().replaceConfig({ ...defaultConfig, channels: [channel], videoModel: encodeChannelModel(channel.id, "grok-imagine-video") });
        useCreationPreferencesStore.setState({ hydrated: true, preferences: { mode: "video" } });
        const page = await fixture(conversation("video", "pending", []));
        try {
            await act(async () => composer.setPrompt("茶山的电影镜头"));
            await act(async () => composer.onSubmit());
            expect(page.latestMessage()).toMatchObject({ status: "done", content: "视频已生成", resultStorageKeys: ["resource:submitted-video"], taskIds: ["submitted-task"] });
            expect(page.latestMessage().error).toBeUndefined();
            expect(page.persisted().messages.at(-1)?.status).toBe("done");
        } finally { await page.dispose(); }
    });
}
