import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { archiveNodes, archiveEdges, archiveUploadName, base64Blob, safeArchiveName, sha256, validateArchive } from "../src/pages/collaboration/board-archive.ts";

const node = (kind = "text") => ({ id: randomUUID(), kind, position: { x: -420.5, y: 130 }, width: 320, height: 240, title: "中文节点", content: "文字\n第二行", fileId: null, version: 7 });
const edge = (source, target, targetPort = "input") => ({ id: randomUUID(), source: source.id, sourcePort: "output", target: target.id, targetPort, version: 4 });
const archive = (nodes = [], edges = [], assets = []) => ({ app: "infinite-canvas-collaboration", version: 1, title: "离线画布", exportedAt: new Date().toISOString(), nodes: archiveNodes(nodes), edges: archiveEdges(edges), assets });

test("public snapshot preserves supported node data and strips private payloads and versions", () => {
    const group = { ...node("group"), content: "" };
    const board = { ...node("whiteboard"), groupId: group.id, drawing: [{ type: "text", position: { x: 3, y: 7 }, text: "白板\n文字", color: "currentColor", size: 24 }] };
    const hidden = { ...node("private"), title: "SECRET", content: "SECRET", privateData: { apiKey: "SECRET" }, request: "SECRET", fileId: randomUUID(), groupId: group.id, drawing: board.drawing };
    const nodes = [group, board, hidden, node("markdown"), { ...node("custom"), outputType: "json" }, node("image"), node("video"), node("file")];
    const data = validateArchive(archive(nodes));
    assert.equal(data.nodes.length, nodes.length);
    assert.deepEqual(data.nodes[1].drawing, board.drawing);
    assert.equal(data.nodes[1].groupId, group.id);
    assert.equal(data.nodes[4].outputType, "json");
    assert.deepEqual(data.nodes[2].position, hidden.position);
    assert.ok(!JSON.stringify(data).includes("SECRET"));
    assert.ok(data.nodes.every((item) => !("version" in item)));
    board.drawing[0].text = "后续修改";
    assert.equal(data.nodes[1].drawing[0].text, "白板\n文字");
});

test("archive format rejects unknown versions, credentials and malformed geometry", () => {
    const data = archive([node()]);
    assert.throws(() => validateArchive({ ...data, version: 2 }), /版本/);
    assert.throws(() => validateArchive({ ...data, csrf: "secret" }), /格式/);
    for (const fields of [{ width: -1 }, { height: Infinity }, { position: { x: NaN, y: 0 } }, { privateData: { apiKey: "secret" } }]) {
        assert.throws(() => validateArchive({ ...data, nodes: [{ ...data.nodes[0], ...fields }] }), /格式/);
    }
    const hidden = archive([node("private")]);
    hidden.nodes[0].content = "secret";
    assert.throws(() => validateArchive(hidden), /空白占位/);
});

test("group and file references must be complete, unique and type-correct", () => {
    const group = node("group"), member = { ...node(), groupId: group.id };
    assert.doesNotThrow(() => validateArchive(archive([member, group])));
    assert.throws(() => validateArchive(archive([member])), /分组/);
    assert.throws(() => validateArchive(archive([{ ...group, groupId: group.id }])), /分组/);
    assert.throws(() => validateArchive(archive([member, group, member])), /重复/);
    const asset = { id: randomUUID(), name: "图片.png", mime: "image/png", size: 0, sha256: "a".repeat(64) };
    const picture = { ...node("image"), fileId: asset.id };
    assert.doesNotThrow(() => validateArchive(archive([picture], [], [asset])));
    assert.throws(() => validateArchive(archive([picture])), /缺少附件/);
    assert.throws(() => validateArchive(archive([], [], [asset])), /未被节点引用/);
    assert.throws(() => validateArchive(archive([picture], [], [{ ...asset, mime: "image/svg+xml" }])), /格式/);
    assert.throws(() => validateArchive(archive([picture], [], [{ ...asset, mime: "application/octet-stream" }])), /类型不匹配/);
    assert.equal(archiveUploadName({ ...asset, name: "已改名的节点.exe" }), `${asset.id}.png`);
    assert.equal(archiveUploadName({ ...asset, mime: "application/octet-stream", name: "伪装图片.png" }), `${asset.id}.bin`);
});

test("connections preserve topology and reject cycles, occupied ports and private output leaks", () => {
    const text = node(), custom = node("custom"), second = node("custom"), privateNode = node("private");
    const connections = [edge(text, custom), edge(custom, privateNode)];
    assert.equal(validateArchive(archive([text, custom, privateNode], connections)).edges.length, 2);
    assert.throws(() => validateArchive(archive([custom, second], [edge(custom, second), edge(second, custom)])), /循环/);
    assert.throws(() => validateArchive(archive([text, custom, second], [edge(text, custom), edge(second, custom)])), /多条连线/);
    assert.throws(() => validateArchive(archive([privateNode, custom], [edge(privateNode, custom)])), /隐私输出/);
    assert.throws(() => validateArchive(archive([custom], [edge(text, custom)])), /节点或端口/);
    assert.throws(() => validateArchive(archive([text, custom], [edge(text, custom, "image")])), /图片输入/);
    assert.throws(() => validateArchive(archive([text, custom], [edge(text, custom, "audio")])), /音频输入/);
});

test("attachments decode losslessly across block boundaries, including empty files", async () => {
    for (const length of [0, 1, 2, 3, 49151, 49152, 49153, 150001]) {
        const bytes = Uint8Array.from({ length }, (_, index) => index % 251);
        const encoded = Buffer.from(bytes).toString("base64");
        const blob = base64Blob(encoded, "application/octet-stream");
        assert.equal(blob.size, length);
        assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), bytes);
        assert.equal(await sha256(blob), await sha256(new Blob([bytes])));
    }
});

test("download filenames cannot introduce paths or control characters", () => {
    assert.equal(safeArchiveName('../图片\\test:<a>\u0000.png'), '.._图片_test__a__.png');
    assert.equal(safeArchiveName("   "), "协作画布");
});
