import "dotenv/config";
import express from "express";
import cors from "cors";
import { createServer } from "http";
import { Server } from "socket.io";
import { generateResponse, getHealthStatus } from "./ai-orchestrator.js";
import { setupSocketHandlers, getDeviceRegistry, getDeviceVideoState } from "./socket-handlers.js";
import axios from "axios";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function sseWrite(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

async function callOpenRouter(systemPrompt, userMessage) {
  const res = await axios.post(
    "https://openrouter.ai/api/v1/chat/completions",
    {
      model: "qwen/qwen3-8b",   // ← change this
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user",   content: userMessage },
      ],
      temperature: 0.15,                      // ← add (or 0.1–0.2)
      max_tokens: 1200,                       // ← optional but good to cap
      // response_format: { type: "json_object" }, // ← add this
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
        // Optional: force better routing if you want
        // "HTTP-Referer": "https://your-app.com",           // shows in OpenRouter stats
        // "X-Title": "Whiteboard Tutor Planner",
      },
      timeout: 45000,                         // ← add timeout (45s)
    }
  );

  // Better safety
  if (!res.data?.choices?.[0]?.message?.content) {
    throw new Error(
      `OpenRouter error: ${res.status} - ${JSON.stringify(res.data?.error || "no content")}`
    );
  }

  return res.data.choices[0].message.content.trim();
}

function parseJsonResponse(raw) {
  const noThink = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  const cleaned = noThink.replace(/^```[a-z]*\n?/i, "").replace(/```$/i, "").trim();
  return JSON.parse(cleaned);
}

const SUPPORTED_VISUAL_TYPES = new Set(["shape", "text", "line", "arrow"]);

function clampNumber(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

function normalizeVisualStyle(style = {}) {
  return {
    color: typeof style.color === "string" && style.color.trim() ? style.color.trim() : "#2563eb",
    highlight: Boolean(style.highlight),
  };
}

function validateVisualElement(visual, index = 0) {
  if (!visual || typeof visual !== "object") return null;
  if (!SUPPORTED_VISUAL_TYPES.has(visual.type)) return null;

  const position = visual.position && typeof visual.position === "object" ? visual.position : {};
  return {
    id: typeof visual.id === "string" && visual.id.trim() ? visual.id.trim() : `v${index + 1}`,
    type: visual.type,
    content: visual.content === undefined || visual.content === null ? "" : String(visual.content),
    position: {
      x: clampNumber(Number(position.x), 240 + index * 110),
      y: clampNumber(Number(position.y), 180),
    },
    style: normalizeVisualStyle(visual.style),
  };
}

function validateVisuals(visuals) {
  if (!Array.isArray(visuals)) return [];
  return visuals.map((visual, index) => validateVisualElement(visual, index)).filter(Boolean);
}

function splitChatIntoSentences(chat = "") {
  return String(chat)
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function distributeVisualsAcrossSentences(sentences, visuals) {
  const safeSentences = Array.isArray(sentences) ? sentences : [];
  const safeVisuals = Array.isArray(visuals) ? visuals : [];
  if (!safeSentences.length) return [];

  const cues = safeSentences.map((sentence, sentenceIndex) => ({
    sentenceIndex,
    sentence,
    visualIndices: [],
    visuals: [],
    highlightIds: [],
  }));

  if (!safeVisuals.length) return cues;

  safeVisuals.forEach((visual, visualIndex) => {
    const bucket = Math.min(
      safeSentences.length - 1,
      Math.floor((visualIndex * safeSentences.length) / safeVisuals.length)
    );
    cues[bucket].visualIndices.push(visualIndex);
    cues[bucket].visuals.push(visual);
    if (visual.style?.highlight) {
      cues[bucket].highlightIds.push(visual.id);
    }
  });

  return cues;
}

function extractKeyTerm(question = "") {
  const cleaned = String(question)
    .replace(/[^\w\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "Concept";

  const stopWords = new Set([
    "how", "does", "do", "is", "are", "what", "why", "the", "a", "an", "of", "in", "to", "for", "and", "with",
    "explain", "work", "works", "tell", "me", "about", "please", "step", "by", "walkthrough",
  ]);

  const words = cleaned
    .split(" ")
    .map((word) => word.trim())
    .filter(Boolean)
    .filter((word) => !stopWords.has(word.toLowerCase()));

  return (words.slice(0, 3).join(" ") || cleaned.split(" ").slice(0, 3).join(" ")).trim() || "Concept";
}

function makeVisual(id, type, content, x, y, style = {}) {
  return {
    id,
    type,
    content,
    position: { x, y },
    style: normalizeVisualStyle(style),
  };
}

function buildConceptBoxVisuals(question, color = "#2563eb") {
  const keyTerm = extractKeyTerm(question);
  return validateVisuals([
    makeVisual("v1", "shape", "Formula/Concept", 260, 170, { color, highlight: true }),
    makeVisual("v2", "text", keyTerm, 295, 208, { color: "#0f172a", highlight: true }),
    makeVisual("v3", "text", "Main idea", 300, 250, { color: "#64748b", highlight: false }),
  ]);
}

function flattenTree(root, level = 0, index = 0, parent = null, nodes = [], edges = []) {
  if (!root || typeof root !== "object") return { nodes, edges };

  const id = `node_${level}_${index}`;
  const x = 260 + index * 140 - level * 28;
  const y = 140 + level * 110;
  nodes.push({ id, label: root.value, x, y });

  if (parent) {
    edges.push({ from: parent, to: id });
  }

  if (root.left) flattenTree(root.left, level + 1, index * 2, id, nodes, edges);
  if (root.right) flattenTree(root.right, level + 1, index * 2 + 1, id, nodes, edges);
  return { nodes, edges };
}

function graphToVisuals(graph, title = "Graph") {
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph?.edges) ? graph.edges : [];
  const nodeMap = new Map();
  const visuals = [makeVisual("v1", "text", title, 220, 70, { color: "#0f172a", highlight: false })];

  nodes.forEach((node, index) => {
    const id = `g_node_${index + 1}`;
    const x = clampNumber(node?.x, 220 + (index % 3) * 180);
    const y = clampNumber(node?.y, 150 + Math.floor(index / 3) * 120);
    nodeMap.set(node.id, { x, y, id });
    visuals.push(makeVisual(id, "shape", String(node?.label || node?.id || `N${index + 1}`), x, y, { color: "#2563eb", highlight: false }));
  });

  edges.forEach((edge, index) => {
    const from = nodeMap.get(edge?.from);
    const to = nodeMap.get(edge?.to);
    if (!from || !to) return;
    visuals.push(makeVisual(`g_edge_${index + 1}`, "arrow", String(edge?.label || `${edge.from}->${edge.to}`), (from.x + to.x) / 2, (from.y + to.y) / 2, { color: "#64748b", highlight: false }));
  });

  return validateVisuals(visuals);
}

function diagramToVisuals(diagram, question = "") {
  if (!diagram || typeof diagram !== "object" || typeof diagram.type !== "string") {
    return buildConceptBoxVisuals(question);
  }

  switch (diagram.type) {
    case "formula":
      return validateVisuals([
        makeVisual("v1", "shape", diagram.label || "Formula/Concept", 250, 160, { color: "#2563eb", highlight: true }),
        makeVisual("v2", "text", diagram.expression || extractKeyTerm(question), 285, 205, { color: "#0f172a", highlight: true }),
      ]);
    case "array":
      return validateVisuals([
        makeVisual("v1", "text", diagram.label || "Array", 200, 80, { color: "#0f172a", highlight: false }),
        ...(diagram.values || []).flatMap((value, index) => ([
          makeVisual(`v${index * 2 + 2}`, "shape", `cell ${index}`, 180 + index * 110, 180, {
            color: Array.isArray(diagram.highlightedIndices) && diagram.highlightedIndices.includes(index) ? "#f59e0b" : "#2563eb",
            highlight: Array.isArray(diagram.highlightedIndices) && diagram.highlightedIndices.includes(index),
          }),
          makeVisual(`v${index * 2 + 3}`, "text", String(value), 212 + index * 110, 218, {
            color: "#0f172a",
            highlight: Array.isArray(diagram.highlightedIndices) && diagram.highlightedIndices.includes(index),
          }),
        ])),
      ]);
    case "binary_search":
      return validateVisuals([
        makeVisual("v1", "text", diagram.title || "Binary Search", 180, 70, { color: "#0f172a", highlight: false }),
        ...(diagram.array || []).flatMap((value, index) => {
          const isMid = index === diagram.mid_index;
          const isLow = index === diagram.low_index;
          const isHigh = index === diagram.high_index;
          const x = 160 + index * 95;
          return [
            makeVisual(`v_box_${index}`, "shape", `cell ${index}`, x, 180, {
              color: isMid ? "#f59e0b" : "#2563eb",
              highlight: isMid || isLow || isHigh,
            }),
            makeVisual(`v_text_${index}`, "text", String(value), x + 28, 218, {
              color: "#0f172a",
              highlight: isMid,
            }),
            ...(isMid ? [makeVisual(`v_mid_${index}`, "text", "mid", x + 18, 145, { color: "#f59e0b", highlight: true })] : []),
            ...(isLow ? [makeVisual(`v_low_${index}`, "text", "low", x + 18, 270, { color: "#059669", highlight: true })] : []),
            ...(isHigh ? [makeVisual(`v_high_${index}`, "text", "high", x + 8, 300, { color: "#dc2626", highlight: true })] : []),
          ];
        }),
      ]);
    case "linked_list":
      return validateVisuals([
        makeVisual("v1", "text", "Linked List", 200, 80, { color: "#0f172a", highlight: false }),
        ...(diagram.values || []).flatMap((value, index) => {
          const x = 170 + index * 150;
          return [
            makeVisual(`v_box_${index}`, "shape", "node", x, 180, { color: "#2563eb", highlight: index === 0 }),
            makeVisual(`v_text_${index}`, "text", String(value), x + 24, 218, { color: "#0f172a", highlight: false }),
            ...(index < (diagram.values || []).length - 1
              ? [makeVisual(`v_arrow_${index}`, "arrow", "next", x + 115, 214, { color: "#64748b", highlight: false })]
              : []),
          ];
        }),
      ]);
    case "tree": {
      const flattened = flattenTree(diagram.root);
      return graphToVisuals(flattened, diagram.title || "Tree");
    }
    case "triangle":
      return validateVisuals([
        makeVisual("v1", "text", diagram.title || "Triangle", 220, 70, { color: "#0f172a", highlight: false }),
        makeVisual("v2", "line", "base", 300, 320, { color: "#2563eb", highlight: false }),
        makeVisual("v3", "line", "height", 240, 220, { color: "#059669", highlight: false }),
        makeVisual("v4", "line", "hypotenuse", 360, 215, { color: "#f59e0b", highlight: true }),
        makeVisual("v5", "text", diagram.labels?.a || "base", 320, 336, { color: "#2563eb", highlight: false }),
        makeVisual("v6", "text", diagram.labels?.b || "height", 210, 230, { color: "#059669", highlight: false }),
        makeVisual("v7", "text", diagram.labels?.c || "hypotenuse", 365, 208, { color: "#f59e0b", highlight: true }),
      ]);
    case "graph":
      return graphToVisuals(diagram, "Graph");
    default:
      return buildConceptBoxVisuals(question);
  }
}

function algorithmToVisuals(algorithm, question = "") {
  if (!algorithm || typeof algorithm !== "object" || typeof algorithm.type !== "string") {
    return buildConceptBoxVisuals(question);
  }

  switch (algorithm.type) {
    case "lis_dp":
      return validateVisuals([
        makeVisual("v1", "text", algorithm.title || "Longest Increasing Subsequence", 150, 70, { color: "#0f172a", highlight: false }),
        makeVisual("v2", "text", "Input array", 150, 130, { color: "#64748b", highlight: false }),
        ...(algorithm.array || []).flatMap((value, index) => ([
          makeVisual(`v_arr_${index}`, "shape", `a${index}`, 150 + index * 95, 180, { color: "#2563eb", highlight: index === 0 }),
          makeVisual(`v_arr_text_${index}`, "text", String(value), 178 + index * 95, 218, { color: "#0f172a", highlight: index === 0 }),
          makeVisual(`v_dp_${index}`, "shape", `dp${index}`, 150 + index * 95, 290, { color: "#059669", highlight: index === 0 }),
          makeVisual(`v_dp_text_${index}`, "text", "1", 184 + index * 95, 328, { color: "#0f172a", highlight: index === 0 }),
        ])),
      ]);
    case "binary_search_walkthrough":
      return diagramToVisuals({
        type: "binary_search",
        title: algorithm.title || "Binary Search Walkthrough",
        array: algorithm.array || [],
        mid_index: Math.floor(((algorithm.array || []).length || 1) / 2),
        low_index: 0,
        high_index: Math.max(0, (algorithm.array || []).length - 1),
      }, question).concat(validateVisuals([
        makeVisual("v_target", "text", `Target: ${String(algorithm.target)}`, 180, 110, { color: "#dc2626", highlight: true }),
      ]));
    case "bubble_sort":
    case "insertion_sort":
      return validateVisuals([
        makeVisual("v1", "text", algorithm.title || algorithm.type.replace(/_/g, " "), 180, 70, { color: "#0f172a", highlight: false }),
        ...(algorithm.array || []).flatMap((value, index) => ([
          makeVisual(`v_box_${index}`, "shape", `cell ${index}`, 180 + index * 100, 190, {
            color: index < 2 ? "#f59e0b" : "#2563eb",
            highlight: index < 2,
          }),
          makeVisual(`v_text_${index}`, "text", String(value), 210 + index * 100, 228, {
            color: "#0f172a",
            highlight: index < 2,
          }),
        ])),
        makeVisual("v_note", "text", algorithm.type === "bubble_sort" ? "Compare neighbors" : "Insert into sorted left side", 190, 300, {
          color: "#64748b",
          highlight: true,
        }),
      ]);
    case "bfs":
    case "dfs":
      return graphToVisuals(algorithm.graph, algorithm.title || algorithm.type.toUpperCase()).concat(validateVisuals([
        makeVisual("v_start", "text", `Start: ${algorithm.start || "A"}`, 180, 110, { color: "#059669", highlight: true }),
      ]));
    case "knapsack_dp":
      return validateVisuals([
        makeVisual("v1", "text", algorithm.title || "Knapsack DP", 180, 70, { color: "#0f172a", highlight: false }),
        makeVisual("v2", "shape", `Capacity ${algorithm.capacity}`, 180, 140, { color: "#f59e0b", highlight: true }),
        ...(algorithm.weights || []).flatMap((weight, index) => ([
          makeVisual(`v_item_${index}`, "shape", `item ${index + 1}`, 150 + index * 150, 250, { color: "#2563eb", highlight: false }),
          makeVisual(`v_item_text_${index}`, "text", `w=${weight}, v=${algorithm.values?.[index]}`, 164 + index * 150, 288, { color: "#0f172a", highlight: false }),
        ])),
      ]);
    default:
      return buildConceptBoxVisuals(question);
  }
}

function buildVisualLesson(question, chat, visuals) {
  const safeChat = typeof chat === "string" && chat.trim()
    ? chat.trim()
    : explainQuestionHeuristically(question, true);
  const safeVisuals = validateVisuals(visuals);
  const finalVisuals = safeVisuals.length ? safeVisuals : buildConceptBoxVisuals(question);
  const sentences = splitChatIntoSentences(safeChat);

  return {
    topic: typeof question === "string" ? question.trim() : "",
    chat: safeChat,
    visuals: finalVisuals,
    sync: distributeVisualsAcrossSentences(sentences, finalVisuals),
  };
}

const SUPPORTED_DIAGRAMS = new Set([
  "binary_search",
  "array",
  "linked_list",
  "tree",
  "triangle",
  "graph",
  "formula",
]);

const SUPPORTED_ALGORITHM_TYPES = new Set([
  "lis_dp",
  "binary_search_walkthrough",
  "bubble_sort",
  "insertion_sort",
  "bfs",
  "dfs",
  "knapsack_dp",
]);
const SUPPORTED_ALGORITHM_STEPS = new Set([
  "array",
  "dp_array",
  "compare",
  "update",
  "highlight_index",
  "arrow",
  "annotation",
  "code",
  "result",
  "swap",
  "graph",
  "visit_node",
  "frontier",
  "matrix",
  "matrix_update",
  "highlight_cell",
]);


function validateDiagram(diagram) {
  if (!diagram || typeof diagram !== "object" || typeof diagram.type !== "string") {
    return null;
  }

  if (!SUPPORTED_DIAGRAMS.has(diagram.type)) {
    console.warn(`[Planner] Skipping unknown diagram type: "${diagram.type}"`);
    return null;
  }

  switch (diagram.type) {
    case "binary_search":
      if (!Array.isArray(diagram.array) || typeof diagram.mid_index !== "number") return null;
      return {
        type: "binary_search",
        array: diagram.array,
        mid_index: diagram.mid_index,
        low_index: typeof diagram.low_index === "number" ? diagram.low_index : 0,
        high_index: typeof diagram.high_index === "number" ? diagram.high_index : diagram.array.length - 1,
        title: typeof diagram.title === "string" ? diagram.title : undefined,
      };
    case "array":
      if (!Array.isArray(diagram.values)) return null;
      return {
        type: "array",
        values: diagram.values,
        highlightedIndices: Array.isArray(diagram.highlightedIndices) ? diagram.highlightedIndices : [],
        label: typeof diagram.label === "string" ? diagram.label : undefined,
      };
    case "linked_list":
      if (!Array.isArray(diagram.values)) return null;
      return { type: "linked_list", values: diagram.values };
    case "tree":
      if (!diagram.root || typeof diagram.root !== "object") return null;
      return {
        type: "tree",
        root: diagram.root,
        title: typeof diagram.title === "string" ? diagram.title : undefined,
      };
    case "triangle":
      return {
        type: "triangle",
        labels: diagram.labels && typeof diagram.labels === "object" ? diagram.labels : undefined,
        title: typeof diagram.title === "string" ? diagram.title : undefined,
      };
    case "graph":
      if (!Array.isArray(diagram.nodes) || !Array.isArray(diagram.edges)) return null;
      return { type: "graph", nodes: diagram.nodes, edges: diagram.edges };
    case "formula":
      if (typeof diagram.expression !== "string") return null;
      return {
        type: "formula",
        expression: diagram.expression,
        label: typeof diagram.label === "string" ? diagram.label : undefined,
      };
    default:
      return null;
  }
}

function validateAlgorithmStep(step, arrayLength) {
  if (!step || typeof step !== "object" || typeof step.type !== "string") return null;
  if (!SUPPORTED_ALGORITHM_STEPS.has(step.type)) return null;

  switch (step.type) {
    case "array":
      if (!Array.isArray(step.values)) return null;
      return { type: "array", values: step.values };
    case "dp_array":
      if (!Array.isArray(step.values)) return null;
      return {
        type: "dp_array",
        values: step.values,
        label: typeof step.label === "string" ? step.label : "dp",
      };
    case "compare":
      if (typeof step.i !== "number" || typeof step.j !== "number") return null;
      if (step.i < 0 || step.i >= arrayLength || step.j < 0 || step.j >= arrayLength) return null;
      return { type: "compare", i: step.i, j: step.j };
    case "update":
      if (typeof step.index !== "number" || step.index < 0 || step.index >= arrayLength) return null;
      if (step.value === undefined) return null;
      return { type: "update", index: step.index, value: step.value };
    case "highlight_index":
      if (typeof step.index !== "number" || step.index < 0 || step.index >= arrayLength) return null;
      return {
        type: "highlight_index",
        index: step.index,
        row: step.row === "dp" ? "dp" : "array",
      };
    case "arrow":
      return {
        type: "arrow",
        from: typeof step.from === "string" ? step.from : undefined,
        to: typeof step.to === "string" ? step.to : undefined,
        label: typeof step.label === "string" ? step.label : undefined,
      };
    case "annotation":
      if (typeof step.text !== "string") return null;
      return { type: "annotation", text: step.text };
    case "code":
      if (typeof step.text !== "string") return null;
      return { type: "code", text: step.text };
    case "result":
      if (typeof step.text !== "string") return null;
      return { type: "result", text: step.text };
    case "swap":
      if (typeof step.i !== "number" || typeof step.j !== "number") return null;
      if (step.i < 0 || step.j < 0 || step.i >= arrayLength || step.j >= arrayLength) return null;
      return { type: "swap", i: step.i, j: step.j };
    case "graph":
      if (!Array.isArray(step.nodes) || !Array.isArray(step.edges)) return null;
      return { type: "graph", nodes: step.nodes, edges: step.edges };
    case "visit_node":
      if (typeof step.node !== "string") return null;
      return { type: "visit_node", node: step.node };
    case "frontier":
      if (typeof step.label !== "string" || !Array.isArray(step.values)) return null;
      return { type: "frontier", label: step.label, values: step.values };
    case "matrix":
      if (!Array.isArray(step.values) || !step.values.every((row) => Array.isArray(row))) return null;
      return { type: "matrix", values: step.values, label: typeof step.label === "string" ? step.label : "dp" };
    case "matrix_update":
      if (typeof step.row !== "number" || typeof step.col !== "number" || step.value === undefined) return null;
      return { type: "matrix_update", row: step.row, col: step.col, value: step.value };
    case "highlight_cell":
      if (typeof step.row !== "number" || typeof step.col !== "number") return null;
      return { type: "highlight_cell", row: step.row, col: step.col };
    default:
      return null;
  }
}

function validateAlgorithm(algorithm) {
  if (!algorithm || typeof algorithm !== "object" || typeof algorithm.type !== "string") {
    return null;
  }

  if (!SUPPORTED_ALGORITHM_TYPES.has(algorithm.type)) {
    console.warn(`[Planner] Skipping unknown algorithm type: "${algorithm.type}"`);
    return null;
  }

  const title = typeof algorithm.title === "string" ? algorithm.title : algorithm.type.replace(/_/g, " ");
  const code = typeof algorithm.code === "string" ? algorithm.code : undefined;

  if (Array.isArray(algorithm.steps) && algorithm.steps.length) {
    const arrayStep = algorithm.steps.find((step) => step?.type === "array" && Array.isArray(step.values));
    const arrayLength = Array.isArray(arrayStep?.values) ? arrayStep.values.length : 64;
    const validatedSteps = algorithm.steps.map((step) => validateAlgorithmStep(step, arrayLength)).filter(Boolean);
    if (validatedSteps.length) {
      return { ...algorithm, title, code, steps: validatedSteps };
    }
  }

  switch (algorithm.type) {
    case "lis_dp": {
      if (!Array.isArray(algorithm.array) || !algorithm.array.length) return null;
      return { type: "lis_dp", title, code, array: algorithm.array };
    }
    case "binary_search_walkthrough": {
      if (!Array.isArray(algorithm.array) || !algorithm.array.length) return null;
      if (algorithm.target === undefined) return null;
      return { type: "binary_search_walkthrough", title, code, array: algorithm.array, target: algorithm.target };
    }
    case "bubble_sort": {
      if (!Array.isArray(algorithm.array) || !algorithm.array.length) return null;
      return { type: "bubble_sort", title, code, array: algorithm.array };
    }
    case "insertion_sort": {
      if (!Array.isArray(algorithm.array) || !algorithm.array.length) return null;
      return { type: "insertion_sort", title, code, array: algorithm.array };
    }
    case "bfs":
    case "dfs": {
      if (!algorithm.graph || !Array.isArray(algorithm.graph.nodes) || !algorithm.graph.nodes.length) return null;
      if (!Array.isArray(algorithm.graph.edges)) return null;
      const start = typeof algorithm.start === "string" ? algorithm.start : algorithm.graph.nodes[0]?.id;
      if (!start) return null;
      return { type: algorithm.type, title, code, graph: algorithm.graph, start };
    }
    case "knapsack_dp": {
      if (!Array.isArray(algorithm.weights) || !algorithm.weights.length) return null;
      if (!Array.isArray(algorithm.values) || !algorithm.values.length) return null;
      if (typeof algorithm.capacity !== "number") return null;
      if (algorithm.weights.length !== algorithm.values.length) return null;
      return { type: "knapsack_dp", title, code, weights: algorithm.weights, values: algorithm.values, capacity: algorithm.capacity };
    }
    default:
      return null;
  }
}

function inferAlgorithmType(question) {
  const q = question.toLowerCase();
  if (q.includes("longest increasing subsequence") || q.includes(" lis")) return "lis_dp";
  if (q.includes("binary search")) return "binary_search_walkthrough";
  if (q.includes("bubble sort")) return "bubble_sort";
  if (q.includes("insertion sort")) return "insertion_sort";
  if (q.includes("breadth first search") || /\bbfs\b/.test(q)) return "bfs";
  if (q.includes("depth first search") || /\bdfs\b/.test(q)) return "dfs";
  if (q.includes("knapsack")) return "knapsack_dp";
  if (q.includes("dynamic programming") && q.includes("subsequence")) return "lis_dp";
  if (q.includes("dynamic programming") && q.includes("capacity")) return "knapsack_dp";
  return "";
}

function shouldUseAlgorithm(question) {
  const q = question.toLowerCase();
  return Boolean(
    inferAlgorithmType(question) ||
      q.includes("step by step") ||
      q.includes("dry run") ||
      q.includes("walkthrough") ||
      q.includes("algorithm execution") ||
      q.includes("trace the algorithm")
  );
}

function inferDiagramType(question) {
  const q = question.toLowerCase();
  if (q.includes("binary search")) return "binary_search";
  if (q.includes("linked list")) return "linked_list";
  if (q.includes("tree") || q.includes("bst")) return "tree";
  if (q.includes("triangle") || q.includes("pythag")) return "triangle";
  if (q.includes("graph") || q.includes("network")) return "graph";
  if (q.includes("array") || q.includes("list")) return "array";
  if (q.includes("formula") || q.includes("equation") || q.includes("area") || q.includes("perimeter")) return "formula";
  return "formula";
}

function fallbackDiagramForQuestion(question, preferredType = "formula") {
  const type = preferredType || inferDiagramType(question);
  switch (type) {
    case "binary_search":
      return {
        type: "binary_search",
        array: [1, 3, 5, 7, 9, 11, 13],
        mid_index: 3,
        low_index: 0,
        high_index: 6,
        title: "Binary Search",
      };
    case "array":
      return { type: "array", values: [1, 2, 3, 4, 5], label: "array" };
    case "linked_list":
      return { type: "linked_list", values: [10, 20, 30, 40] };
    case "tree":
      return {
        type: "tree",
        title: "Tree Structure",
        root: {
          value: "Root",
          left: { value: "Left" },
          right: { value: "Right" },
        },
      };
    case "triangle":
      return {
        type: "triangle",
        title: "Triangle",
        labels: { a: "base", b: "height", c: "hypotenuse" },
      };
    case "graph":
      return {
        type: "graph",
        nodes: [{ id: "A" }, { id: "B" }, { id: "C" }, { id: "D" }, { id: "E" }],
        edges: [{ from: "A", to: "B" }, { from: "A", to: "C" }, { from: "B", to: "D" }, { from: "C", to: "E" }],
      };
    case "formula":
    default:
      return {
        type: "formula",
        label: "Key Idea",
        expression: question.trim().slice(0, 56) || "Concept overview",
      };
  }
}

function buildDoubtFallback(question, errorMessage = "") {
  const safeQuestion = typeof question === "string" ? question.trim() : "";
  const chat = errorMessage
    ? `I hit a temporary planning issue, so here is a simpler explanation for ${safeQuestion || "this topic"}. Let's break it down step by step.`
    : `Here is a simple explanation for ${safeQuestion || "this topic"}. Let's break it down step by step.`;

  return buildVisualLesson(safeQuestion || "Concept overview", chat, buildConceptBoxVisuals(safeQuestion || "Concept overview"));
}

function fallbackAlgorithmForQuestion(question, preferredType = "") {
  const type = preferredType || inferAlgorithmType(question);

  switch (type) {
    case "binary_search_walkthrough":
      return {
        type: "binary_search_walkthrough",
        title: "Binary Search Walkthrough",
        array: [1, 3, 5, 7, 9, 11, 13],
        target: 7,
        code: "while (low <= high) { mid = Math.floor((low + high) / 2); }",
      };
    case "bubble_sort":
      return {
        type: "bubble_sort",
        title: "Bubble Sort",
        array: [5, 1, 4, 2, 8],
        code: "for each pass, swap adjacent elements if they are out of order",
      };
    case "insertion_sort":
      return {
        type: "insertion_sort",
        title: "Insertion Sort",
        array: [12, 11, 13, 5, 6],
        code: "insert each element into the correct place in the sorted left side",
      };
    case "bfs":
      return {
        type: "bfs",
        title: "Breadth First Search",
        start: "A",
        graph: {
          nodes: [{ id: "A" }, { id: "B" }, { id: "C" }, { id: "D" }],
          edges: [{ from: "A", to: "B" }, { from: "A", to: "C" }, { from: "B", to: "D" }],
        },
        code: "queue = [start]; visit nodes level by level",
      };
    case "dfs":
      return {
        type: "dfs",
        title: "Depth First Search",
        start: "A",
        graph: {
          nodes: [{ id: "A" }, { id: "B" }, { id: "C" }, { id: "D" }],
          edges: [{ from: "A", to: "B" }, { from: "A", to: "C" }, { from: "B", to: "D" }],
        },
        code: "go as deep as possible before backtracking",
      };
    case "knapsack_dp":
      return {
        type: "knapsack_dp",
        title: "Knapsack DP",
        weights: [1, 3, 4, 5],
        values: [1, 4, 5, 7],
        capacity: 7,
        code: "dp[i][w] = best value using first i items with capacity w",
      };
    case "lis_dp":
    default:
      return {
        type: "lis_dp",
        title: "Longest Increasing Subsequence",
        array: [10, 9, 2, 5, 3, 7, 101, 18],
        code: "dp[i] stores the LIS length ending at index i",
      };
  }
}

function explainQuestionHeuristically(question, feynmanMode = false) {
  const q = (question || "").toLowerCase();

  if (q.includes("binary search")) {
    return feynmanMode
      ? "Binary search finds an item in a sorted list by checking the middle first. If the middle value is too small, it throws away the left half, and if it is too large, it throws away the right half. This keeps cutting the search space into half, so it becomes very fast."
      : "Binary search is a fast way to find a value in a sorted list. It checks the middle element and keeps discarding half of the remaining list until the target is found or nothing is left.";
  }

  if (q.includes("dynamic programming") || q.includes("longest increasing subsequence") || q.includes(" lis")) {
    return feynmanMode
      ? "Dynamic programming solves a big problem by saving answers to smaller problems. For LIS, we track the best increasing subsequence ending at each position and build the final answer from those smaller results. This avoids repeating the same work again and again."
      : "Dynamic programming breaks a problem into smaller overlapping subproblems and stores their answers. In LIS, we compute the best increasing subsequence length at each index and reuse those results efficiently.";
  }

  if (q.includes("bubble sort")) {
    return "Bubble sort repeatedly compares neighboring elements and swaps them if they are in the wrong order. After each pass, the largest unsorted element moves to its correct place.";
  }

  if (q.includes("insertion sort")) {
    return "Insertion sort builds the sorted part one element at a time. Each new element is inserted into the correct position among the elements that are already sorted.";
  }

  if (q.includes("breadth first search") || /\bbfs\b/.test(q)) {
    return "Breadth first search explores a graph level by level. It uses a queue, so it visits all nearby nodes before moving deeper into the graph.";
  }

  if (q.includes("depth first search") || /\bdfs\b/.test(q)) {
    return "Depth first search goes as deep as possible along one path before backtracking. It is commonly implemented with recursion or a stack.";
  }

  if (q.includes("knapsack")) {
    return "The knapsack problem asks for the most valuable set of items that fits within a weight limit. Dynamic programming solves it by comparing the best result when we include an item versus when we skip it.";
  }

  if (q.includes("linked list")) {
    return "A linked list stores elements as nodes, and each node points to the next one. It is easy to insert or remove nodes, but random access is slower than in an array.";
  }

  if (q.includes("tree")) {
    return "A tree is a hierarchical structure made of nodes connected by parent-child links. It is useful for representing relationships such as folders, expressions, or search structures.";
  }

  if (q.includes("graph")) {
    return "A graph is a collection of nodes connected by edges. It is useful for modeling networks, maps, and relationships between objects.";
  }

  if (q.includes("array")) {
    return "An array stores elements in contiguous positions, so accessing an element by index is fast. It works well when you want ordered data and quick lookup by position.";
  }

  return feynmanMode
    ? `This topic can be understood by breaking it into smaller ideas. We first identify what the main concept does, then see how its parts work together, and finally connect that back to the full problem.`
    : `This concept becomes easier when we break it into smaller parts, understand what each part does, and then combine those parts into the full idea.`;
}

async function buildHeuristicLesson(question, feynmanMode = false) {
  const wantsAlgorithm = shouldUseAlgorithm(question);
  const algorithmType = inferAlgorithmType(question);
  const diagramType = inferDiagramType(question);

  let chat = "";
  try {
    const teachingPrompt = feynmanMode
      ? `Explain this like a patient classroom tutor teaching a 12-year-old. Use 2 to 4 short sentences, simple words, and make the idea intuitive first.\n\nQuestion: ${question}`
      : `Give a brief classroom-friendly explanation in 2 to 4 short sentences.\n\nQuestion: ${question}`;

    const result = await generateResponse([{ role: "user", content: teachingPrompt }]);
    chat = result.response?.trim?.() || "";
  } catch (err) {
    console.warn("[Planner] Local heuristic lesson generation failed:", err.message);
  }

  if (!chat) {
    chat = explainQuestionHeuristically(question, feynmanMode);
  }

  if (wantsAlgorithm) {
    return buildVisualLesson(question, chat, algorithmToVisuals(fallbackAlgorithmForQuestion(question, algorithmType), question));
  }

  return buildVisualLesson(question, chat, diagramToVisuals(fallbackDiagramForQuestion(question, diagramType), question));
}

async function runPlannerPipeline(question, feynmanMode = false) {
  const wantsAlgorithm = shouldUseAlgorithm(question);
  const heuristicAlgorithmType = inferAlgorithmType(question);
  const heuristicDiagramType = inferDiagramType(question);

  if (!process.env.OPENROUTER_API_KEY) {
    console.warn("[Planner] OPENROUTER_API_KEY not configured - using heuristic doubt pipeline");
    return buildHeuristicLesson(question, feynmanMode);
  }

  const plannerSystem = wantsAlgorithm
    ? `You are a teaching planner for an AI whiteboard tutor.

Choose whether the student needs an ALGORITHM walkthrough or a static DIAGRAM.

Respond with ONLY valid JSON:
{
  "mode": "algorithm",
  "algorithm_type": "lis_dp"
}

Rules:
- Use "algorithm" when the student asks for step-by-step execution, dry run, DP progression, or algorithm walkthrough.
- Allowed algorithm_type values:
  - lis_dp
  - binary_search_walkthrough
  - bubble_sort
  - insertion_sort
  - bfs
  - dfs
  - knapsack_dp
- Match the algorithm_type to the question.
- Use "diagram" only for static concept visuals.`
    : `You are a teaching planner for an AI whiteboard tutor.

Your job is to choose the one clean diagram template that best explains the student's question.

Respond with ONLY valid JSON:
{
  "mode": "diagram",
  "diagram_type": "formula"
}

Allowed diagram_type values:
- formula       (DEFAULT — use for any general, conceptual, or non-structural question)
- triangle      (geometry, Pythagoras, trigonometry)
- array         (only if the question is explicitly about arrays or lists)
- linked_list   (only if the question is explicitly about linked lists)
- tree          (only if the question is explicitly about trees or BST)
- graph         (only if the question is explicitly about graphs or networks)
- binary_search (ONLY if the question explicitly mentions binary search)

Rule: When in doubt, always pick "formula". Only pick a structural type if the question clearly names that data structure.`;

  let planMode = wantsAlgorithm ? "algorithm" : "diagram";
  let plannedDiagramType = heuristicDiagramType;
  let plannedAlgorithmType = wantsAlgorithm ? heuristicAlgorithmType || "lis_dp" : "";

  try {
    const planRaw = await callOpenRouter(plannerSystem, question);
    const plan = parseJsonResponse(planRaw);
    if (plan.mode === "algorithm" && typeof plan.algorithm_type === "string") {
      planMode = "algorithm";
      plannedAlgorithmType = plan.algorithm_type;
    } else if (plan.mode === "diagram" && typeof plan.diagram_type === "string") {
      planMode = "diagram";
      plannedDiagramType = plan.diagram_type;
    }
    // Safety: if heuristic says "formula" (no data-structure keywords in question)
    // but LLM picked a structural type, trust the heuristic over the LLM
    const _structuralTypes = ["binary_search", "array", "linked_list", "tree", "graph"];
    if (_structuralTypes.includes(plannedDiagramType) && inferDiagramType(question) === "formula") {
      console.log(`[Planner] LLM picked "${plannedDiagramType}" but heuristic says formula — overriding to formula`);
      plannedDiagramType = "formula";
    }
    console.log(`[Planner] Mode for "${question}": ${planMode}, diagram: ${plannedDiagramType}`);
  } catch (err) {
    console.warn("[Planner] Planning stage failed, continuing with heuristic:", err.message);
    // On failure, heuristic is already set — no override needed
  }

  const feynmanExtra = feynmanMode
    ? `
- Use a very simple real-world analogy that a 12-year-old would understand.
- Keep the analogy short (1-2 sentences maximum).
- Use words like "imagine", "you", or "suppose" to make it personal.
- Immediately connect the analogy back to the actual concept in one clear sentence.
- Avoid long stories, technical jargon, or multiple examples.
- Focus on making the idea intuitive before showing the formal explanation.
`
    : "";

  if (planMode === "algorithm") {
    const algorithmSystem = `You are a teaching assistant generating:
1) a short spoken explanation
2) one structured algorithm instruction for a lecture-style whiteboard

You MUST respond with ONLY valid JSON.
No markdown.
No reasoning.
No extra text.

Use exactly this structure:
{
  "chat": "Sentence one. Sentence two. Sentence three.",
  "algorithm": { ... }
}

Rules:
- Return a minimal algorithm object with the parameters needed to animate the lesson.
- Do not include primitive whiteboard drawing instructions.
- Do not include a "steps" array unless you are very confident.
- Use one of these shapes depending on the algorithm:
  1. LIS:
     { "type": "lis_dp", "title": "...", "array": [10,9,2,5,3,7,101,18], "code": "..." }
  2. Binary search:
     { "type": "binary_search_walkthrough", "title": "...", "array": [1,3,5,7,9], "target": 7, "code": "..." }
  3. Bubble sort / insertion sort:
     { "type": "bubble_sort", "title": "...", "array": [5,1,4,2,8], "code": "..." }
     { "type": "insertion_sort", "title": "...", "array": [12,11,13,5,6], "code": "..." }
  4. BFS / DFS:
     { "type": "bfs", "title": "...", "start": "A", "graph": { "nodes": [{ "id": "A" }, { "id": "B" }], "edges": [{ "from": "A", "to": "B" }] }, "code": "..." }
  5. Knapsack:
     { "type": "knapsack_dp", "title": "...", "weights": [1,3,4,5], "values": [1,4,5,7], "capacity": 7, "code": "..." }
- Keep the chat to 2-4 sentences.
${feynmanExtra}`;

    const algorithmUser = `Question: ${question}\n\nUse algorithm type: ${plannedAlgorithmType || "lis_dp"}`;
    try {
      const algorithmRaw = await callOpenRouter(algorithmSystem, algorithmUser);
      const generated = parseJsonResponse(algorithmRaw);

      if (typeof generated.chat !== "string") {
        throw new Error("Algorithm response missing 'chat' field");
      }

      const validAlgorithm = validateAlgorithm(generated.algorithm);
      const visuals = validAlgorithm
        ? algorithmToVisuals(validAlgorithm, question)
        : algorithmToVisuals(fallbackAlgorithmForQuestion(question, plannedAlgorithmType), question);
      if (!validAlgorithm) {
        console.warn("[Planner] Algorithm failed validation - using fallback algorithm visuals");
      }

      return buildVisualLesson(question, generated.chat, visuals);
    } catch (err) {
      console.warn("[Planner] Algorithm generation failed, using heuristic lesson:", err.message);
      return buildVisualLesson(
        question,
        explainQuestionHeuristically(question, feynmanMode),
        buildConceptBoxVisuals(question)
      );
    }
  }

  const diagramSystem = `You are a Feynman-style teacher generating:
1) a short spoken explanation
2) a dynamic visual instruction plan for a digital whiteboard

The explanation and visuals must stay tightly synchronized.

You MUST respond with ONLY valid JSON.
No markdown.
No reasoning.
No extra text.

Use exactly this structure:
{
  "chat": "Sentence one. Sentence two. Sentence three.",
  "visuals": [
    {
      "id": "v1",
      "type": "shape",
      "content": "Sun",
      "position": { "x": 220, "y": 180 },
      "style": { "color": "#f59e0b", "highlight": true }
    }
  ]
}

Rules for chat:
- Explain like you are teaching a curious 12-year-old.
- Use 2 to 4 short sentences.
- Keep the wording brief and clear.
- Every sentence should connect to something visible on the board.
- End each sentence with a period.
${feynmanExtra}

Rules for visuals:
- Use ONLY these primitive types: shape, text, line, arrow.
- Each visual must include: id, type, content, position, style.
- position.x and position.y must be numbers.
- style.color must be a simple color string.
- style.highlight must be true only for the main focus items.
- Put visuals in the exact order they should appear while the explanation is spoken.
- Prefer 4 to 10 visuals total.
- Use simple labeled boxes, circles, arrows, and text instead of complex templates.
- If the topic is abstract, create one clear concept box plus supporting labels/arrows.
- If the topic is a known structure like an array, tree, graph, triangle, or binary search, still express it using primitive visuals.`;

  const diagramUser = plannedDiagramType
    ? `Question: ${question}\n\nPreferred diagram template: ${plannedDiagramType}`
    : question;

  try {
    const genRaw = await callOpenRouter(diagramSystem, diagramUser);
    const generated = parseJsonResponse(genRaw);

    if (typeof generated.chat !== "string") {
      throw new Error("Generator response missing 'chat' field");
    }

    const validVisuals = validateVisuals(generated.visuals);
    if (!validVisuals.length) {
      const _structTypes = ["binary_search", "array", "linked_list", "tree", "graph"];
      const _safeFallbackType =
        _structTypes.includes(plannedDiagramType) && inferDiagramType(question) === "formula"
          ? "formula"
          : plannedDiagramType;
      console.warn(`[Planner] Visual generation failed validation - using fallback ${_safeFallbackType} visuals`);
      return buildVisualLesson(
        question,
        generated.chat,
        diagramToVisuals(fallbackDiagramForQuestion(question, _safeFallbackType), question)
      );
    }

    return buildVisualLesson(question, generated.chat, validVisuals);
  } catch (err) {
    console.warn("[Planner] Diagram generation failed, using heuristic lesson:", err.message);
    return buildVisualLesson(
      question,
      explainQuestionHeuristically(question, feynmanMode),
      buildConceptBoxVisuals(question)
    );
  }
}

const app = express();
const httpServer = createServer(app);

const io = new Server(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

app.use(cors());
app.use(express.json());

setupSocketHandlers(io);

app.get("/health", async (req, res) => {
  const aiStatus = getHealthStatus();
  const devices = getDeviceRegistry();

  let onlineCount = 0;
  let offlineCount = 0;

  for (const device of devices.values()) {
    if (device.status === "online") onlineCount++;
    else offlineCount++;
  }

  res.json({
    status: aiStatus.qwen.available ? "healthy" : "degraded",
    components: {
      ...aiStatus,
      devices: {
        online: onlineCount,
        offline: offlineCount,
        total: devices.size,
      },
    },
    timestamp: new Date().toISOString(),
  });
});

app.post("/chat", async (req, res) => {
  try {
    const userMessages = req.body.messages;
    const result = await generateResponse(userMessages);

    res.json({
      choices: [
        {
          message: {
            role: "assistant",
            content: result.response,
          },
        },
      ],
      source: result.source,
    });
  } catch (err) {
    console.error("Chat error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/devices", (req, res) => {
  const devices = [];
  for (const device of getDeviceRegistry().values()) {
    devices.push({
      deviceId: device.deviceId,
      type: device.type,
      name: device.name,
      status: device.status,
      capabilities: device.capabilities,
      lastHeartbeat: device.lastHeartbeat,
    });
  }
  res.json(devices);
});

app.post("/api/control", (req, res) => {
  const { targetDeviceId, action, params } = req.body;

  let targetDevice = null;
  for (const device of getDeviceRegistry().values()) {
    if (device.deviceId === targetDeviceId) {
      targetDevice = device;
      break;
    }
  }

  if (!targetDevice) {
    return res.status(404).json({ error: "Device not found" });
  }

  const commandId = Date.now().toString();
  io.to(`device:${targetDeviceId}`).emit("control:command", {
    commandId,
    action,
    params,
    issuedBy: "api",
    timestamp: new Date().toISOString(),
  });

  res.json({ success: true, commandId });
});

app.post("/api/broadcast", (req, res) => {
  const { content, type, priority, displayDuration } = req.body;

  io.to("device:classroom").emit("broadcast:message", {
    from: "Admin",
    type: type || "announcement",
    content,
    priority: priority || "normal",
    displayDuration: displayDuration || 30,
    timestamp: new Date().toISOString(),
  });

  res.json({ success: true });
});



app.post("/api/video/play", (req, res) => {
  const { targetDeviceIds, url, autoPlay = true, volume = 1.0 } = req.body;

  if (!targetDeviceIds || !Array.isArray(targetDeviceIds) || !url) {
    return res.status(400).json({ error: "targetDeviceIds (array) and url required" });
  }

  const commandId = `vid-api-${Date.now()}`;

  for (const deviceId of targetDeviceIds) {
    io.to(`device:${deviceId}`).emit("video:play", {
      commandId,
      url,
      autoPlay,
      volume,
      issuedBy: "api",
      timestamp: new Date().toISOString(),
    });
  }

  res.json({ success: true, commandId, targetCount: targetDeviceIds.length });
});

app.post("/api/video/stop", (req, res) => {
  const { targetDeviceIds } = req.body;

  if (!targetDeviceIds || !Array.isArray(targetDeviceIds)) {
    return res.status(400).json({ error: "targetDeviceIds (array) required" });
  }

  const commandId = `vid-stop-api-${Date.now()}`;

  for (const deviceId of targetDeviceIds) {
    io.to(`device:${deviceId}`).emit("video:stop", {
      commandId,
      issuedBy: "api",
      timestamp: new Date().toISOString(),
    });
  }

  res.json({ success: true, commandId, targetCount: targetDeviceIds.length });
});

app.get("/api/video/state", (req, res) => {
  res.json(getDeviceVideoState());
});

app.get("/api/doubt/stream", async (req, res) => {
  const question = req.query.q;
  const feynmanMode = true;

  if (!question) {
    return res.status(400).json({ error: "q query param required" });
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  let disconnected = false;
  req.on("close", () => disconnected = true);

  try {
    const parsed = await runPlannerPipeline(question.trim(), feynmanMode);

    sseWrite(res, {
      type: "lesson_start",
      payload: {
        topic: parsed.topic || question.trim(),
        mode: "visuals",
      }
    });

    const cues = Array.isArray(parsed.sync) && parsed.sync.length
      ? parsed.sync
      : distributeVisualsAcrossSentences(splitChatIntoSentences(parsed.chat), parsed.visuals);

    for (let i = 0; i < cues.length; i++) {
      if (disconnected) return;

      const cue = cues[i];
      sseWrite(res, {
        type: "chat_chunk",
        payload: cue.sentence,
      });

      await wait(100);

      sseWrite(res, {
        type: "visual_chunk",
        payload: {
          sentenceIndex: cue.sentenceIndex,
          visualIndices: cue.visualIndices,
          visuals: cue.visuals,
          highlightIds: cue.highlightIds,
        },
      });

      await wait(180);
    }

    if (!disconnected) {
      sseWrite(res, { type: "complete" });
      res.end();
    }

  } catch (err) {
    if (!disconnected) {
      console.error("Doubt stream error:", err.message);
      const fallback = buildDoubtFallback(question, err.message);

      sseWrite(res, {
        type: "lesson_start",
        payload: {
          topic: question.trim(),
          mode: "visuals",
        },
      });
      const fallbackCues = Array.isArray(fallback.sync) && fallback.sync.length
        ? fallback.sync
        : distributeVisualsAcrossSentences(splitChatIntoSentences(fallback.chat), fallback.visuals);
      for (const cue of fallbackCues) {
        sseWrite(res, { type: "chat_chunk", payload: cue.sentence });
        sseWrite(res, {
          type: "visual_chunk",
          payload: {
            sentenceIndex: cue.sentenceIndex,
            visualIndices: cue.visualIndices,
            visuals: cue.visuals,
            highlightIds: cue.highlightIds,
          },
        });
      }
      sseWrite(res, { type: "complete" });
      res.end();
    }
  }
});
app.post("/api/doubt", async (req, res) => {
  try {
    const { question } = req.body;

    if (!question || typeof question !== "string" || !question.trim()) {
      return res.status(400).json({ success: false, error: "question is required" });
    }

    const data = await runPlannerPipeline(question.trim());
    return res.json({ success: true, data });
  } catch (err) {
    console.error("Doubt API error:", err.message);
    const fallback = buildDoubtFallback(req.body?.question, err.message);
    return res.json({ success: true, data: fallback, fallback: true });
  }
});

app.post("/api/feynman", async (req, res) => {
  try {
    const { topic, history = [], message } = req.body;
    const isFirstTurn = history.length === 0;

    if (!isFirstTurn && (!message || typeof message !== "string" || !message.trim())) {
      return res.status(400).json({ success: false, error: "message is required" });
    }

    const systemPrompt = `You are a curious, enthusiastic student who is trying to understand "${topic || "a concept"}".
The user is acting as the teacher explaining the concept to you using the Feynman Technique.

Your job:
- Ask ONE short, targeted probing question that exposes the weakest or most unclear part of their explanation
- Pretend you are genuinely confused or curious
- Never explain the concept yourself
- Keep your question to 1-2 sentences maximum
- If their explanation is complete and clear, say you think you get it now, summarize what you understood in 1 sentence, then ask one final check question

You MUST respond with ONLY a valid JSON object.
No markdown.
No thinking tags.
No preamble.

Use exactly this structure:
{
  "chat": "Your probing question or understanding check (1-2 sentences)",
  "diagram": null,
  "algorithm": null
}`;

    const firstTurnPrompt = `The student wants to explain "${topic || "a concept"}" to you. Ask them to start explaining it in their own words. Be friendly and encouraging. Keep it to 1-2 sentences.`;

    let responseRaw;
    if (isFirstTurn) {
      responseRaw = await callOpenRouter(systemPrompt, firstTurnPrompt);
    } else {
      const historyText = history
        .map((entry) => `${entry.role === "user" ? "Student" : "You"}: ${entry.content}`)
        .join("\n");
      const multiTurnPrompt = `Conversation so far:\n${historyText}\n\nStudent now says: ${message.trim()}\n\nRespond with your probing question JSON.`;
      responseRaw = await callOpenRouter(systemPrompt, multiTurnPrompt);
    }

    const parsed = parseJsonResponse(responseRaw);
    if (typeof parsed.chat !== "string") {
      throw new Error("Feynman response missing 'chat' field");
    }

    return res.json({ success: true, data: { chat: parsed.chat, diagram: null, algorithm: null } });
  } catch (err) {
    console.error("Feynman API error:", err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

const PORT = process.env.PORT || 5000;

httpServer.listen(PORT, () => {
  console.log(`Supernode running on http://localhost:${PORT}`);
  console.log("Socket.io server ready for device connections");

  if (process.env.OPENROUTER_API_KEY) {
    console.log(`Qwen AI ready via OpenRouter (model: ${process.env.QWEN_MODEL || "qwen/qwen3-8b"})`);
  } else {
    console.log("Warning: OPENROUTER_API_KEY not set — AI features will not work");
  }
});
