import "dotenv/config";
import express from "express";
import cors from "cors";
import { createServer } from "http";
import { Server } from "socket.io";
import { generateResponse, getHealthStatus } from "./ai-orchestrator.js";
import { setupSocketHandlers, getDeviceRegistry, getDeviceVideoState } from "./socket-handlers.js";
import axios from "axios";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ATTENDANCE_SERVICE_URL = (process.env.ATTENDANCE_SERVICE_URL || "http://localhost:8000").replace(/\/$/, "");

function sseWrite(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

async function proxyAttendanceRequest(res, config) {
  try {
    const response = await axios({
      timeout: 45000,
      validateStatus: () => true,
      ...config,
    });

    if (response.status >= 400) {
      return res.status(response.status).json(
        response.data && typeof response.data === "object"
          ? response.data
          : { error: "Attendance service error", detail: response.data }
      );
    }

    return res.status(response.status).json(response.data);
  } catch (error) {
    console.error("Attendance proxy error:", error.message);
    return res.status(502).json({
      error: "Attendance service unavailable",
      detail: error.message,
    });
  }
}

async function callOpenRouter(systemPrompt, userMessage) {
  const res = await axios.post(
    "https://openrouter.ai/api/v1/chat/completions",
    {
      model: process.env.QWEN_MODEL || "qwen/qwen3-8b",   // ← change this
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

const TIMELINE_ACTIONS = new Set(["draw", "highlight", "connect", "erase", "label"]);

function rectEntity(id, x, y, width, height, text, style = {}) {
  return {
    id,
    kind: "rectangle",
    x,
    y,
    width,
    height,
    text,
    style: {
      strokeColor: style.strokeColor || "#2563eb",
      fillColor: style.fillColor || "#ffffff",
      textColor: style.textColor || "#0f172a",
    },
  };
}

function ellipseEntity(id, x, y, width, height, text, style = {}) {
  return {
    id,
    kind: "ellipse",
    x,
    y,
    width,
    height,
    text,
    style: {
      strokeColor: style.strokeColor || "#2563eb",
      fillColor: style.fillColor || "#ffffff",
      textColor: style.textColor || "#0f172a",
    },
  };
}

function diamondEntity(id, x, y, width, height, text, style = {}) {
  return {
    id,
    kind: "diamond",
    x,
    y,
    width,
    height,
    text,
    style: {
      strokeColor: style.strokeColor || "#2563eb",
      fillColor: style.fillColor || "#ffffff",
      textColor: style.textColor || "#0f172a",
    },
  };
}

function triangleEntity(id, x, y, width, height, text, style = {}) {
  return {
    id,
    kind: "triangle",
    x,
    y,
    width,
    height,
    text,
    style: {
      strokeColor: style.strokeColor || "#2563eb",
      fillColor: style.fillColor || "#ffffff",
      textColor: style.textColor || "#0f172a",
    },
  };
}

function textEntity(id, x, y, text, style = {}) {
  return {
    id,
    kind: "text",
    x,
    y,
    text,
    style: {
      strokeColor: style.strokeColor || "#0f172a",
      fontSize: style.fontSize || 28,
      textAlign: style.textAlign || "center",
    },
  };
}

function lineEntity(id, x1, y1, x2, y2, text = "", style = {}) {
  return {
    id,
    kind: "line",
    x1,
    y1,
    x2,
    y2,
    text,
    style: {
      strokeColor: style.strokeColor || "#2563eb",
      textColor: style.textColor || "#64748b",
    },
  };
}

function connectorEntity(id, from, to, text = "", style = {}) {
  return {
    id,
    kind: "connector",
    from,
    to,
    text,
    style: {
      strokeColor: style.strokeColor || "#64748b",
      textColor: style.textColor || "#64748b",
      arrow: style.arrow !== false,
    },
  };
}

function estimateSpeechDurationMs(text = "") {
  const words = String(text).trim().split(/\s+/).filter(Boolean).length;
  return Math.max(2400, Math.min(7000, words * 360));
}

function buildLessonPlanFromTemplate(question, template) {
  const timeline = (template.steps || []).map((step, index) => {
    const speechText = String(step.speech_text || "").trim();
    const estimated_duration_ms = estimateSpeechDurationMs(speechText);
    return {
      step_number: index + 1,
      speech_text: speechText,
      estimated_duration_ms,
      ops: Array.isArray(step.ops) ? step.ops : [],
    };
  });

  return {
    topic: question.trim(),
    mode: "timeline",
    plan_version: 1,
    template_id: template.template_id,
    speech: {
      segments: timeline.map((step) => ({
        step_number: step.step_number,
        speech_text: step.speech_text,
        estimated_duration_ms: step.estimated_duration_ms,
      })),
    },
    timeline,
    board_template: {
      entities: template.entities,
    },
  };
}

function lessonTemplateRegistry(question = "") {
  const keyTerm = extractKeyTerm(question);

  return {
    "science.photosynthesis.v1": {
      template_id: "science.photosynthesis.v1",
      entities: {
        topic_title: textEntity("topic_title", 420, 70, "Photosynthesis", { fontSize: 34 }),
        sun_icon: ellipseEntity("sun_icon", 130, 120, 120, 120, "Sun", { strokeColor: "#f59e0b", fillColor: "#fef3c7" }),
        plant_body: rectEntity("plant_body", 360, 210, 180, 110, "Plant", { strokeColor: "#16a34a", fillColor: "#dcfce7" }),
        water_box: rectEntity("water_box", 120, 350, 150, 74, "Water", { strokeColor: "#0ea5e9", fillColor: "#e0f2fe" }),
        carbon_box: rectEntity("carbon_box", 620, 170, 170, 74, "Carbon dioxide", { strokeColor: "#64748b", fillColor: "#f8fafc" }),
        oxygen_box: rectEntity("oxygen_box", 630, 320, 150, 74, "Oxygen", { strokeColor: "#38bdf8", fillColor: "#e0f2fe" }),
        glucose_box: rectEntity("glucose_box", 350, 390, 200, 74, "Glucose food", { strokeColor: "#f97316", fillColor: "#ffedd5" }),
        sunlight_link: connectorEntity("sunlight_link", "sun_icon", "plant_body", "sunlight", { strokeColor: "#f59e0b", textColor: "#92400e" }),
        water_link: connectorEntity("water_link", "water_box", "plant_body", "water", { strokeColor: "#0ea5e9" }),
        carbon_link: connectorEntity("carbon_link", "carbon_box", "plant_body", "CO2", { strokeColor: "#64748b" }),
        oxygen_link: connectorEntity("oxygen_link", "plant_body", "oxygen_box", "O2", { strokeColor: "#38bdf8" }),
      },
      steps: [
        {
          speech_text: "Photosynthesis is the way plants make their own food.",
          ops: [
            { action: "label", entity: "topic_title" },
            { action: "draw", entity: "plant_body" },
            { action: "draw", entity: "sun_icon" },
            { action: "highlight", entity: "plant_body" },
          ],
        },
        {
          speech_text: "The plant takes in sunlight, water, and carbon dioxide as its main inputs.",
          ops: [
            { action: "draw", entity: "water_box" },
            { action: "draw", entity: "carbon_box" },
            { action: "connect", entity: "sunlight_link" },
            { action: "connect", entity: "water_link" },
            { action: "connect", entity: "carbon_link" },
          ],
        },
        {
          speech_text: "Using those inputs, the plant makes glucose for food and releases oxygen back into the air.",
          ops: [
            { action: "draw", entity: "glucose_box" },
            { action: "draw", entity: "oxygen_box" },
            { action: "connect", entity: "oxygen_link" },
            { action: "highlight", entity: "glucose_box" },
            { action: "highlight", entity: "oxygen_box" },
          ],
        },
      ],
    },
    "science.water_cycle.v1": {
      template_id: "science.water_cycle.v1",
      entities: {
        topic_title: textEntity("topic_title", 420, 70, "Water Cycle", { fontSize: 34 }),
        sun_icon: ellipseEntity("sun_icon", 120, 110, 110, 110, "Sun", { strokeColor: "#f59e0b", fillColor: "#fef3c7" }),
        water_body: rectEntity("water_body", 260, 380, 230, 76, "Lake / Ocean", { strokeColor: "#0ea5e9", fillColor: "#dbeafe" }),
        cloud_box: rectEntity("cloud_box", 500, 120, 190, 74, "Clouds", { strokeColor: "#94a3b8", fillColor: "#f8fafc" }),
        land_box: rectEntity("land_box", 610, 370, 160, 76, "Land", { strokeColor: "#65a30d", fillColor: "#ecfccb" }),
        evaporation_link: connectorEntity("evaporation_link", "water_body", "cloud_box", "evaporation", { strokeColor: "#0ea5e9" }),
        condensation_link: connectorEntity("condensation_link", "sun_icon", "cloud_box", "condensation", { strokeColor: "#64748b" }),
        precipitation_link: connectorEntity("precipitation_link", "cloud_box", "land_box", "rain", { strokeColor: "#1d4ed8" }),
        collection_link: connectorEntity("collection_link", "land_box", "water_body", "collection", { strokeColor: "#059669" }),
      },
      steps: [
        {
          speech_text: "The water cycle is the journey water takes as it moves around Earth.",
          ops: [
            { action: "label", entity: "topic_title" },
            { action: "draw", entity: "water_body" },
            { action: "draw", entity: "cloud_box" },
            { action: "draw", entity: "sun_icon" },
          ],
        },
        {
          speech_text: "Heat from the sun makes water evaporate and rise up, where it cools and forms clouds.",
          ops: [
            { action: "connect", entity: "evaporation_link" },
            { action: "connect", entity: "condensation_link" },
            { action: "highlight", entity: "cloud_box" },
          ],
        },
        {
          speech_text: "Then precipitation falls back to land and water collects again, so the cycle keeps repeating.",
          ops: [
            { action: "draw", entity: "land_box" },
            { action: "connect", entity: "precipitation_link" },
            { action: "connect", entity: "collection_link" },
            { action: "highlight", entity: "water_body" },
          ],
        },
      ],
    },
    "biology.human_heart.v1": {
      template_id: "biology.human_heart.v1",
      entities: {
        topic_title: textEntity("topic_title", 420, 70, "Human Heart", { fontSize: 34 }),
        heart_box: rectEntity("heart_box", 350, 200, 180, 120, "Heart", { strokeColor: "#dc2626", fillColor: "#fee2e2" }),
        lungs_box: rectEntity("lungs_box", 120, 170, 170, 82, "Lungs", { strokeColor: "#0ea5e9", fillColor: "#e0f2fe" }),
        body_box: rectEntity("body_box", 620, 250, 170, 82, "Body", { strokeColor: "#8b5cf6", fillColor: "#ede9fe" }),
        deoxy_link: connectorEntity("deoxy_link", "body_box", "heart_box", "low oxygen blood", { strokeColor: "#2563eb" }),
        lungs_link: connectorEntity("lungs_link", "heart_box", "lungs_box", "to lungs", { strokeColor: "#0ea5e9" }),
        oxy_link: connectorEntity("oxy_link", "lungs_box", "heart_box", "oxygen-rich blood", { strokeColor: "#dc2626" }),
        body_return: connectorEntity("body_return", "heart_box", "body_box", "to body", { strokeColor: "#dc2626" }),
      },
      steps: [
        {
          speech_text: "The heart is a strong pump that keeps blood moving through the whole body.",
          ops: [
            { action: "label", entity: "topic_title" },
            { action: "draw", entity: "heart_box" },
            { action: "highlight", entity: "heart_box" },
          ],
        },
        {
          speech_text: "Blood travels from the body to the heart, and then the heart sends it to the lungs to pick up oxygen.",
          ops: [
            { action: "draw", entity: "body_box" },
            { action: "draw", entity: "lungs_box" },
            { action: "connect", entity: "deoxy_link" },
            { action: "connect", entity: "lungs_link" },
          ],
        },
        {
          speech_text: "After getting oxygen in the lungs, the blood returns to the heart and is pumped back out to the body.",
          ops: [
            { action: "connect", entity: "oxy_link" },
            { action: "connect", entity: "body_return" },
            { action: "highlight", entity: "body_box" },
          ],
        },
      ],
    },
    "physics.solar_system.v1": {
      template_id: "physics.solar_system.v1",
      entities: {
        topic_title: textEntity("topic_title", 420, 66, "Solar System", { fontSize: 34 }),
        sun_box: ellipseEntity("sun_box", 90, 210, 130, 130, "Sun", { strokeColor: "#f59e0b", fillColor: "#fef3c7" }),
        mercury: ellipseEntity("mercury", 280, 160, 78, 78, "Mercury", { strokeColor: "#94a3b8", fillColor: "#f8fafc" }),
        venus: ellipseEntity("venus", 390, 145, 84, 84, "Venus", { strokeColor: "#f97316", fillColor: "#ffedd5" }),
        earth: ellipseEntity("earth", 510, 135, 90, 90, "Earth", { strokeColor: "#2563eb", fillColor: "#dbeafe" }),
        mars: ellipseEntity("mars", 620, 150, 82, 82, "Mars", { strokeColor: "#dc2626", fillColor: "#fee2e2" }),
        jupiter: ellipseEntity("jupiter", 320, 310, 110, 110, "Jupiter", { strokeColor: "#b45309", fillColor: "#fef3c7" }),
        saturn: ellipseEntity("saturn", 480, 300, 112, 112, "Saturn", { strokeColor: "#a16207", fillColor: "#fef9c3" }),
        uranus: ellipseEntity("uranus", 640, 310, 96, 96, "Uranus", { strokeColor: "#0891b2", fillColor: "#cffafe" }),
        neptune: ellipseEntity("neptune", 760, 320, 96, 96, "Neptune", { strokeColor: "#1d4ed8", fillColor: "#dbeafe" }),
      },
      steps: [
        {
          speech_text: "The solar system is made of the Sun at the center and planets moving around it.",
          ops: [
            { action: "label", entity: "topic_title" },
            { action: "draw", entity: "sun_box" },
            { action: "highlight", entity: "sun_box" },
          ],
        },
        {
          speech_text: "The inner planets are Mercury, Venus, Earth, and Mars, which stay closer to the Sun.",
          ops: [
            { action: "draw", entity: "mercury" },
            { action: "draw", entity: "venus" },
            { action: "draw", entity: "earth" },
            { action: "draw", entity: "mars" },
            { action: "highlight", entity: "earth" },
          ],
        },
        {
          speech_text: "Farther out are the large outer planets like Jupiter and Saturn, followed by Uranus and Neptune.",
          ops: [
            { action: "draw", entity: "jupiter" },
            { action: "draw", entity: "saturn" },
            { action: "draw", entity: "uranus" },
            { action: "draw", entity: "neptune" },
          ],
        },
      ],
    },
    "math.pythagoras.v1": {
      template_id: "math.pythagoras.v1",
      entities: {
        topic_title: textEntity("topic_title", 420, 70, "Pythagoras Theorem", { fontSize: 34 }),
        side_a: lineEntity("side_a", 250, 360, 480, 360, "a", { strokeColor: "#2563eb" }),
        side_b: lineEntity("side_b", 250, 360, 250, 170, "b", { strokeColor: "#059669" }),
        side_c: lineEntity("side_c", 250, 170, 480, 360, "c", { strokeColor: "#f59e0b", textColor: "#b45309" }),
        formula_box: rectEntity("formula_box", 560, 200, 180, 86, "a^2 + b^2 = c^2", { strokeColor: "#7c3aed", fillColor: "#f3e8ff" }),
      },
      steps: [
        {
          speech_text: "Pythagoras theorem works on a right triangle with two shorter sides and one longest side called the hypotenuse.",
          ops: [
            { action: "label", entity: "topic_title" },
            { action: "draw", entity: "side_a" },
            { action: "draw", entity: "side_b" },
            { action: "draw", entity: "side_c" },
            { action: "highlight", entity: "side_c" },
          ],
        },
        {
          speech_text: "If the shorter sides are a and b, and the hypotenuse is c, then their squares follow a simple relationship.",
          ops: [
            { action: "highlight", entity: "side_a" },
            { action: "highlight", entity: "side_b" },
          ],
        },
        {
          speech_text: "That relationship is a squared plus b squared equals c squared.",
          ops: [
            { action: "draw", entity: "formula_box" },
            { action: "highlight", entity: "formula_box" },
          ],
        },
      ],
    },
    "physics.newtons_laws.v1": {
      template_id: "physics.newtons_laws.v1",
      entities: {
        topic_title: textEntity("topic_title", 430, 68, "Newton's Laws", { fontSize: 34 }),
        law1: rectEntity("law1", 90, 180, 220, 110, "1st Law\nstay at rest or motion", { strokeColor: "#2563eb", fillColor: "#dbeafe" }),
        law2: rectEntity("law2", 340, 180, 220, 110, "2nd Law\nforce = mass x acceleration", { strokeColor: "#059669", fillColor: "#dcfce7" }),
        law3: rectEntity("law3", 590, 180, 220, 110, "3rd Law\naction and reaction", { strokeColor: "#f97316", fillColor: "#ffedd5" }),
        push_arrow: connectorEntity("push_arrow", "law2", "law3", "forces act in pairs", { strokeColor: "#dc2626" }),
      },
      steps: [
        {
          speech_text: "Newton's first law says an object keeps doing what it is already doing unless a force changes it.",
          ops: [
            { action: "label", entity: "topic_title" },
            { action: "draw", entity: "law1" },
            { action: "highlight", entity: "law1" },
          ],
        },
        {
          speech_text: "The second law explains that more force causes more acceleration, while more mass makes acceleration harder.",
          ops: [
            { action: "draw", entity: "law2" },
            { action: "highlight", entity: "law2" },
          ],
        },
        {
          speech_text: "The third law says every action has an equal and opposite reaction.",
          ops: [
            { action: "draw", entity: "law3" },
            { action: "connect", entity: "push_arrow" },
            { action: "highlight", entity: "law3" },
          ],
        },
      ],
    },
    "cs.dsu.v1": {
      template_id: "cs.dsu.v1",
      entities: {
        topic_title: textEntity("topic_title", 420, 70, "Disjoint Set Union", { fontSize: 34 }),
        set_a: ellipseEntity("set_a", 150, 210, 96, 96, "1", { strokeColor: "#2563eb", fillColor: "#dbeafe" }),
        set_b: ellipseEntity("set_b", 320, 210, 96, 96, "2", { strokeColor: "#2563eb", fillColor: "#dbeafe" }),
        set_c: ellipseEntity("set_c", 490, 210, 96, 96, "3", { strokeColor: "#2563eb", fillColor: "#dbeafe" }),
        root_node: ellipseEntity("root_node", 360, 360, 110, 110, "Root", { strokeColor: "#16a34a", fillColor: "#dcfce7" }),
        union_left: connectorEntity("union_left", "set_a", "root_node", "union", { strokeColor: "#16a34a" }),
        union_mid: connectorEntity("union_mid", "set_b", "root_node", "union", { strokeColor: "#16a34a" }),
        union_right: connectorEntity("union_right", "set_c", "root_node", "union", { strokeColor: "#16a34a" }),
        find_label: textEntity("find_label", 640, 360, "find() returns the root", { fontSize: 24, strokeColor: "#7c3aed" }),
      },
      steps: [
        {
          speech_text: "Disjoint Set Union starts by treating each element as its own separate set.",
          ops: [
            { action: "label", entity: "topic_title" },
            { action: "draw", entity: "set_a" },
            { action: "draw", entity: "set_b" },
            { action: "draw", entity: "set_c" },
          ],
        },
        {
          speech_text: "When we union elements, we connect their sets under one common representative root.",
          ops: [
            { action: "draw", entity: "root_node" },
            { action: "connect", entity: "union_left" },
            { action: "connect", entity: "union_mid" },
            { action: "connect", entity: "union_right" },
            { action: "highlight", entity: "root_node" },
          ],
        },
        {
          speech_text: "A find operation follows the parent links until it reaches that shared root.",
          ops: [
            { action: "label", entity: "find_label" },
            { action: "highlight", entity: "set_b" },
            { action: "highlight", entity: "root_node" },
          ],
        },
      ],
    },
    "cs.dfs.v1": {
      template_id: "cs.dfs.v1",
      entities: {
        topic_title: textEntity("topic_title", 420, 70, "Depth First Search", { fontSize: 34 }),
        node_a: ellipseEntity("node_a", 210, 170, 90, 90, "A", { strokeColor: "#2563eb", fillColor: "#dbeafe" }),
        node_b: ellipseEntity("node_b", 380, 170, 90, 90, "B", { strokeColor: "#2563eb", fillColor: "#dbeafe" }),
        node_c: ellipseEntity("node_c", 550, 170, 90, 90, "C", { strokeColor: "#2563eb", fillColor: "#dbeafe" }),
        node_d: ellipseEntity("node_d", 380, 330, 90, 90, "D", { strokeColor: "#2563eb", fillColor: "#dbeafe" }),
        edge_ab: connectorEntity("edge_ab", "node_a", "node_b", "", { strokeColor: "#64748b" }),
        edge_bc: connectorEntity("edge_bc", "node_b", "node_c", "", { strokeColor: "#64748b" }),
        edge_bd: connectorEntity("edge_bd", "node_b", "node_d", "", { strokeColor: "#64748b" }),
        path_label: textEntity("path_label", 650, 340, "Go deep before backtracking", { fontSize: 24, strokeColor: "#7c3aed" }),
      },
      steps: [
        {
          speech_text: "Depth first search begins at one node and keeps moving deeper along a path.",
          ops: [
            { action: "label", entity: "topic_title" },
            { action: "draw", entity: "node_a" },
            { action: "draw", entity: "node_b" },
            { action: "connect", entity: "edge_ab" },
            { action: "highlight", entity: "node_a" },
          ],
        },
        {
          speech_text: "Instead of exploring every nearby node first, DFS follows one branch as far as it can go.",
          ops: [
            { action: "draw", entity: "node_c" },
            { action: "draw", entity: "node_d" },
            { action: "connect", entity: "edge_bc" },
            { action: "connect", entity: "edge_bd" },
            { action: "highlight", entity: "node_c" },
          ],
        },
        {
          speech_text: "Only after reaching the end of a branch does it backtrack and try a different path.",
          ops: [
            { action: "label", entity: "path_label" },
            { action: "highlight", entity: "node_d" },
            { action: "highlight", entity: "node_b" },
          ],
        },
      ],
    },
    "math.fractions.v1": {
      template_id: "math.fractions.v1",
      entities: {
        topic_title: textEntity("topic_title", 420, 68, "Fractions", { fontSize: 34 }),
        whole_box: rectEntity("whole_box", 180, 180, 220, 110, "One whole", { strokeColor: "#2563eb", fillColor: "#dbeafe" }),
        part_box: rectEntity("part_box", 470, 180, 220, 110, "Equal parts", { strokeColor: "#059669", fillColor: "#dcfce7" }),
        fraction_box: rectEntity("fraction_box", 330, 340, 220, 90, "3/4", { strokeColor: "#f97316", fillColor: "#ffedd5" }),
        whole_to_parts: connectorEntity("whole_to_parts", "whole_box", "part_box", "split into equal parts", { strokeColor: "#64748b" }),
      },
      steps: [
        {
          speech_text: "A fraction shows parts of a whole.",
          ops: [
            { action: "label", entity: "topic_title" },
            { action: "draw", entity: "whole_box" },
          ],
        },
        {
          speech_text: "The whole is split into equal parts so we can count how many parts we have.",
          ops: [
            { action: "draw", entity: "part_box" },
            { action: "connect", entity: "whole_to_parts" },
          ],
        },
        {
          speech_text: "For example, three out of four equal parts is written as three over four.",
          ops: [
            { action: "draw", entity: "fraction_box" },
            { action: "highlight", entity: "fraction_box" },
          ],
        },
      ],
    },
    "math.algebra_basics.v1": {
      template_id: "math.algebra_basics.v1",
      entities: {
        topic_title: textEntity("topic_title", 420, 68, "Algebra Basics", { fontSize: 34 }),
        variable_box: rectEntity("variable_box", 180, 180, 180, 90, "x", { strokeColor: "#7c3aed", fillColor: "#f3e8ff" }),
        number_box: rectEntity("number_box", 440, 180, 180, 90, "5", { strokeColor: "#0ea5e9", fillColor: "#e0f2fe" }),
        equation_box: rectEntity("equation_box", 300, 330, 260, 90, "x + 5 = 12", { strokeColor: "#16a34a", fillColor: "#dcfce7" }),
      },
      steps: [
        {
          speech_text: "Algebra uses letters like x to stand for unknown values.",
          ops: [
            { action: "label", entity: "topic_title" },
            { action: "draw", entity: "variable_box" },
          ],
        },
        {
          speech_text: "Those variables can be combined with numbers to make expressions and equations.",
          ops: [
            { action: "draw", entity: "number_box" },
            { action: "draw", entity: "equation_box" },
          ],
        },
        {
          speech_text: "Solving algebra means finding the value that makes the equation true.",
          ops: [
            { action: "highlight", entity: "variable_box" },
            { action: "highlight", entity: "equation_box" },
          ],
        },
      ],
    },
    "generic.concept_box.v1": {
      template_id: "generic.concept_box.v1",
      entities: {
        topic_title: textEntity("topic_title", 420, 70, keyTerm, { fontSize: 34 }),
        core_box: ellipseEntity("core_box", 310, 190, 220, 100, keyTerm, { strokeColor: "#2563eb", fillColor: "#dbeafe" }),
        detail_left: diamondEntity("detail_left", 90, 340, 210, 84, "What it is", { strokeColor: "#059669", fillColor: "#dcfce7" }),
        detail_right: triangleEntity("detail_right", 560, 340, 210, 84, "Why it matters", { strokeColor: "#f97316", fillColor: "#ffedd5" }),
        left_link: connectorEntity("left_link", "core_box", "detail_left", "meaning", { strokeColor: "#059669" }),
        right_link: connectorEntity("right_link", "core_box", "detail_right", "use", { strokeColor: "#f97316" }),
      },
      steps: [
        {
          speech_text: `${keyTerm} becomes easier when we first identify the main idea clearly.`,
          ops: [
            { action: "label", entity: "topic_title" },
            { action: "draw", entity: "core_box" },
            { action: "highlight", entity: "core_box" },
          ],
        },
        {
          speech_text: "Then we can describe what it means in simple words.",
          ops: [
            { action: "draw", entity: "detail_left" },
            { action: "connect", entity: "left_link" },
          ],
        },
        {
          speech_text: "Finally, we connect that idea to why it matters or where it is used.",
          ops: [
            { action: "draw", entity: "detail_right" },
            { action: "connect", entity: "right_link" },
          ],
        },
      ],
    },
    "generic.process_flow.v1": {
      template_id: "generic.process_flow.v1",
      entities: {
        topic_title: textEntity("topic_title", 420, 70, keyTerm, { fontSize: 34 }),
        stage_1: ellipseEntity("stage_1", 90, 220, 190, 88, "Start", { strokeColor: "#2563eb", fillColor: "#dbeafe" }),
        stage_2: diamondEntity("stage_2", 330, 220, 190, 88, "Middle", { strokeColor: "#059669", fillColor: "#dcfce7" }),
        stage_3: rectEntity("stage_3", 570, 220, 190, 88, "Result", { strokeColor: "#f97316", fillColor: "#ffedd5" }),
        flow_1: connectorEntity("flow_1", "stage_1", "stage_2", "step 1", { strokeColor: "#64748b" }),
        flow_2: connectorEntity("flow_2", "stage_2", "stage_3", "step 2", { strokeColor: "#64748b" }),
      },
      steps: [
        {
          speech_text: `${keyTerm} can be understood as a process with a clear beginning.`,
          ops: [
            { action: "label", entity: "topic_title" },
            { action: "draw", entity: "stage_1" },
          ],
        },
        {
          speech_text: "Next, the important change happens in the middle of the process.",
          ops: [
            { action: "draw", entity: "stage_2" },
            { action: "connect", entity: "flow_1" },
          ],
        },
        {
          speech_text: "At the end, we get the final result and can trace how each stage connects.",
          ops: [
            { action: "draw", entity: "stage_3" },
            { action: "connect", entity: "flow_2" },
            { action: "highlight", entity: "stage_3" },
          ],
        },
      ],
    },
    "generic.labeled_system.v1": {
      template_id: "generic.labeled_system.v1",
      entities: {
        topic_title: textEntity("topic_title", 420, 70, keyTerm, { fontSize: 34 }),
        system_box: ellipseEntity("system_box", 320, 210, 220, 110, keyTerm, { strokeColor: "#2563eb", fillColor: "#dbeafe" }),
        label_a: rectEntity("label_a", 90, 170, 180, 74, "Part A", { strokeColor: "#059669", fillColor: "#dcfce7" }),
        label_b: diamondEntity("label_b", 590, 170, 180, 74, "Part B", { strokeColor: "#f97316", fillColor: "#ffedd5" }),
        label_c: ellipseEntity("label_c", 330, 380, 200, 74, "Main output", { strokeColor: "#7c3aed", fillColor: "#f3e8ff" }),
        link_a: connectorEntity("link_a", "label_a", "system_box", "", { strokeColor: "#059669" }),
        link_b: connectorEntity("link_b", "label_b", "system_box", "", { strokeColor: "#f97316" }),
        link_c: connectorEntity("link_c", "system_box", "label_c", "", { strokeColor: "#7c3aed" }),
      },
      steps: [
        {
          speech_text: `${keyTerm} can be explained by focusing on the main system first.`,
          ops: [
            { action: "label", entity: "topic_title" },
            { action: "draw", entity: "system_box" },
            { action: "highlight", entity: "system_box" },
          ],
        },
        {
          speech_text: "Then we label the important parts that affect that system.",
          ops: [
            { action: "draw", entity: "label_a" },
            { action: "draw", entity: "label_b" },
            { action: "connect", entity: "link_a" },
            { action: "connect", entity: "link_b" },
          ],
        },
        {
          speech_text: "Finally, we show the main result that comes out of the system.",
          ops: [
            { action: "draw", entity: "label_c" },
            { action: "connect", entity: "link_c" },
          ],
        },
      ],
    },
  };
}

function classifyTopic(question = "") {
  const q = question.toLowerCase();

  if (/\bphotosynthesis\b/.test(q)) return { templateId: "science.photosynthesis.v1", subject: "science", fallbackMode: "labeled_system" };
  if (/\bwater cycle\b/.test(q)) return { templateId: "science.water_cycle.v1", subject: "science", fallbackMode: "process_flow" };
  if (/\bhuman heart\b|\bheart\b/.test(q)) return { templateId: "biology.human_heart.v1", subject: "biology", fallbackMode: "labeled_system" };
  if (/\bsolar system\b/.test(q)) return { templateId: "physics.solar_system.v1", subject: "physics", fallbackMode: "labeled_system" };
  if (/\bpythagoras\b/.test(q)) return { templateId: "math.pythagoras.v1", subject: "math", fallbackMode: "concept_box" };
  if (/\bnewton'?s laws?\b|\bnewtons laws?\b/.test(q)) return { templateId: "physics.newtons_laws.v1", subject: "physics", fallbackMode: "concept_box" };
  if (/\bdisjoint set union\b|\bdsu\b/.test(q)) return { templateId: "cs.dsu.v1", subject: "computer_science", fallbackMode: "labeled_system" };
  if (/\bdepth first search\b|\bdfs\b/.test(q)) return { templateId: "cs.dfs.v1", subject: "computer_science", fallbackMode: "process_flow" };
  if (/\bfraction/.test(q)) return { templateId: "math.fractions.v1", subject: "math", fallbackMode: "concept_box" };
  if (/\balgebra\b/.test(q)) return { templateId: "math.algebra_basics.v1", subject: "math", fallbackMode: "concept_box" };

  if (/\bcycle\b|\bprocess\b/.test(q)) return { templateId: null, subject: "generic", fallbackMode: "process_flow" };
  if (/\bsystem\b|\bparts\b|\bdiagram\b|\bstructure\b/.test(q)) return { templateId: null, subject: "generic", fallbackMode: "labeled_system" };
  return { templateId: null, subject: "generic", fallbackMode: "concept_box" };
}

function opTargetsValid(op, entities) {
  if (!op || typeof op !== "object" || !TIMELINE_ACTIONS.has(op.action)) return false;
  if (typeof op.entity !== "string" || !entities[op.entity]) return false;
  return true;
}

function validateLessonPlan(plan) {
  if (!plan || typeof plan !== "object") return null;
  if (plan.mode !== "timeline") return null;
  const entities = plan.board_template?.entities;
  if (!entities || typeof entities !== "object") return null;
  if (!Array.isArray(plan.timeline) || !plan.timeline.length) return null;

  const safeTimeline = [];
  for (const step of plan.timeline) {
    if (!step || typeof step !== "object") return null;
    const safeOps = Array.isArray(step.ops) ? step.ops.filter((op) => opTargetsValid(op, entities)) : [];
    if (!safeOps.length && Array.isArray(step.ops) && step.ops.length) return null;
    safeTimeline.push({
      step_number: Number(step.step_number) || safeTimeline.length + 1,
      speech_text: typeof step.speech_text === "string" && step.speech_text.trim() ? step.speech_text.trim() : "Let's understand this step.",
      estimated_duration_ms: clampNumber(Number(step.estimated_duration_ms), estimateSpeechDurationMs(step.speech_text)),
      ops: safeOps,
    });
  }

  if (!safeTimeline.length) return null;

  return {
    topic: typeof plan.topic === "string" ? plan.topic : "",
    mode: "timeline",
    plan_version: 1,
    template_id: typeof plan.template_id === "string" && plan.template_id.trim() ? plan.template_id.trim() : "generic.concept_box.v1",
    speech: {
      segments: safeTimeline.map((step) => ({
        step_number: step.step_number,
        speech_text: step.speech_text,
        estimated_duration_ms: step.estimated_duration_ms,
      })),
    },
    board_template: { entities },
    timeline: safeTimeline,
  };
}

function buildFallbackLessonPlan(question) {
  const { fallbackMode } = classifyTopic(question);
  const registry = lessonTemplateRegistry(question);
  const templateId = fallbackMode === "process_flow"
    ? "generic.process_flow.v1"
    : fallbackMode === "labeled_system"
      ? "generic.labeled_system.v1"
      : "generic.concept_box.v1";
  return buildLessonPlanFromTemplate(question, registry[templateId]);
}

async function refineSpeechText(question, plan) {
  if (!process.env.OPENROUTER_API_KEY || !plan?.timeline?.length) {
    return plan;
  }

  try {
    const systemPrompt = `You rewrite lesson plan speech for a classroom whiteboard tutor.

Return ONLY valid JSON:
{
  "steps": [
    { "step_number": 1, "speech_text": "..." }
  ]
}

Rules:
- Keep the same number of steps.
- Do not change step order.
- Use simple student-friendly English.
- Each step should stay tightly matched to the existing board action.
- Do not mention any new diagram parts.`;

    const userPrompt = JSON.stringify({
      question,
      steps: plan.timeline.map((step) => ({
        step_number: step.step_number,
        speech_text: step.speech_text,
        ops: step.ops,
      })),
    });

    const raw = await callOpenRouter(systemPrompt, userPrompt);
    const parsed = parseJsonResponse(raw);
    const rewritten = Array.isArray(parsed.steps) ? parsed.steps : [];
    if (!rewritten.length || rewritten.length !== plan.timeline.length) {
      return plan;
    }

    const nextTimeline = plan.timeline.map((step, index) => {
      const candidate = rewritten[index];
      const speech_text = typeof candidate?.speech_text === "string" && candidate.speech_text.trim()
        ? candidate.speech_text.trim()
        : step.speech_text;
      return {
        ...step,
        speech_text,
        estimated_duration_ms: estimateSpeechDurationMs(speech_text),
      };
    });

    return validateLessonPlan({
      ...plan,
      timeline: nextTimeline,
      speech: {
        segments: nextTimeline.map((step) => ({
          step_number: step.step_number,
          speech_text: step.speech_text,
          estimated_duration_ms: step.estimated_duration_ms,
        })),
      },
    }) || plan;
  } catch (err) {
    console.warn("[Planner] Speech refinement failed, using template defaults:", err.message);
    return plan;
  }
}

async function buildStructuredLessonPlan(question, feynmanMode = false) {
  const registry = lessonTemplateRegistry(question);
  const { templateId } = classifyTopic(question);

  if (templateId && registry[templateId]) {
    const basePlan = buildLessonPlanFromTemplate(question, registry[templateId]);
    const validatedBase = validateLessonPlan(basePlan) || buildFallbackLessonPlan(question);
    return refineSpeechText(question, validatedBase);
  }

  if (process.env.OPENROUTER_API_KEY) {
    try {
      const visualLesson = await runPlannerPipeline(question, feynmanMode);
      const generatedPlan = buildLessonPlanFromVisualLesson(visualLesson, question);
      const validatedGeneratedPlan = validateLessonPlan(generatedPlan);
      if (validatedGeneratedPlan) {
        return refineSpeechText(question, validatedGeneratedPlan);
      }
      console.warn("[Planner] Generated lesson plan failed validation, falling back to template plan.");
    } catch (err) {
      console.warn("[Planner] Planner pipeline failed, falling back to template plan:", err.message);
    }
  }

  return buildFallbackLessonPlan(question);
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

function visualToTemplateEntity(visual) {
  const x = clampNumber(Number(visual.position?.x), 240);
  const y = clampNumber(Number(visual.position?.y), 180);
  const color = normalizeVisualStyle(visual.style).color;
  const highlight = Boolean(visual.style?.highlight);

  if (visual.type === "shape") {
    return {
      id: visual.id,
      kind: "rectangle",
      x,
      y,
      width: 160,
      height: 90,
      text: String(visual.content || ""),
      style: {
        strokeColor: color,
        fillColor: highlight ? "#eff6ff" : "#ffffff",
        textColor: "#0f172a",
      },
    };
  }

  if (visual.type === "text") {
    return {
      id: visual.id,
      kind: "text",
      x,
      y,
      text: String(visual.content || visual.id),
      style: {
        strokeColor: color,
        fontSize: highlight ? 32 : 24,
        textAlign: "center",
      },
    };
  }

  if (visual.type === "line" || visual.type === "arrow") {
    return {
      id: visual.id,
      kind: "line",
      x1: x,
      y1: y,
      x2: x + 120,
      y2: y,
      text: String(visual.content || ""),
      style: {
        strokeColor: color,
        textColor: "#64748b",
        arrow: visual.type === "arrow",
      },
    };
  }

  return {
    id: visual.id,
    kind: "text",
    x,
    y,
    text: String(visual.content || visual.id),
    style: {
      strokeColor: color,
      fontSize: highlight ? 30 : 24,
      textAlign: "center",
    },
  };
}

function buildLessonPlanFromVisualLesson(visualLesson, question) {
  if (!visualLesson || typeof visualLesson !== "object") return null;

  const visuals = Array.isArray(visualLesson.visuals) ? visualLesson.visuals : [];
  const entities = Object.fromEntries(
    visuals.map((visual) => [visual.id, visualToTemplateEntity(visual)]),
  );

  const sync = Array.isArray(visualLesson.sync) && visualLesson.sync.length
    ? visualLesson.sync
    : distributeVisualsAcrossSentences(splitChatIntoSentences(visualLesson.chat), visuals);

  const timeline = sync.map((cue, index) => {
    const cueVisuals = Array.isArray(cue.visuals) && cue.visuals.length
      ? cue.visuals
      : Array.isArray(cue.visualIndices)
        ? cue.visualIndices.map((visualIndex) => visuals[visualIndex]).filter(Boolean)
        : [];
    const sentence = typeof cue.sentence === "string" && cue.sentence.trim()
      ? cue.sentence.trim()
      : `Step ${index + 1}.`;

    return {
      step_number: index + 1,
      speech_text: sentence,
      estimated_duration_ms: estimateSpeechDurationMs(sentence),
      ops: [
        ...cueVisuals.map((visual) => ({ action: "draw", entity: visual.id })),
        ...(Array.isArray(cue.highlightIds) ? cue.highlightIds.map((entityId) => ({ action: "highlight", entity: entityId })) : []),
      ],
    };
  });

  return {
    topic: typeof visualLesson.topic === "string" && visualLesson.topic.trim() ? visualLesson.topic.trim() : question.trim(),
    mode: "timeline",
    plan_version: 1,
    template_id: "generated.visuals.v1",
    speech: {
      segments: timeline.map((step) => ({
        step_number: step.step_number,
        speech_text: step.speech_text,
        estimated_duration_ms: step.estimated_duration_ms,
      })),
    },
    board_template: { entities },
    timeline,
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
  if (q.includes("selection sort")) return "selection_sort";
  if (q.includes("merge sort")) return "merge_sort";
  if (q.includes("quick sort") || q.includes("quicksort")) return "quick_sort";
  if (q.includes("linear search")) return "linear_search";
  if (q.includes("stack")) return "stack_push_pop";
  if (q.includes("queue")) return "queue_enqueue_dequeue";
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
    case "selection_sort":
      return {
        type: "selection_sort",
        title: "Selection Sort",
        array: [29, 10, 14, 37, 13],
        code: "find minimum in unsorted part, swap it to front",
      };
    case "merge_sort":
      return {
        type: "merge_sort",
        title: "Merge Sort",
        array: [38, 27, 43, 3, 9, 82, 10],
        code: "divide array in half, sort each half, merge them",
      };
    case "quick_sort":
      return {
        type: "quick_sort",
        title: "Quick Sort",
        array: [10, 7, 8, 9, 1, 5],
        code: "pick pivot, partition around it, recurse on both sides",
      };
    case "linear_search":
      return {
        type: "linear_search",
        title: "Linear Search",
        array: [4, 2, 7, 1, 9, 3, 6, 8],
        target: 9,
        code: "scan each element one by one until target found",
      };
    case "stack_push_pop":
      return {
        type: "stack_push_pop",
        title: "Stack Push & Pop",
        values: [10, 20, 30, 40, 50],
        code: "push adds to top; pop removes from top (LIFO)",
      };
    case "queue_enqueue_dequeue":
      return {
        type: "queue_enqueue_dequeue",
        title: "Queue Enqueue & Dequeue",
        values: [10, 20, 30, 40, 50],
        code: "enqueue adds to rear; dequeue removes from front (FIFO)",
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

  if (q.includes("selection sort")) {
    return "Selection sort finds the smallest element in the unsorted portion and swaps it to the front. It repeats this for each position, building the sorted section one element at a time.";
  }

  if (q.includes("merge sort")) {
    return "Merge sort splits the array in half repeatedly until each piece has one element, then merges those pieces back together in sorted order. It is efficient and stable with O(n log n) time complexity.";
  }

  if (q.includes("quick sort") || q.includes("quicksort")) {
    return "Quick sort picks a pivot element and partitions the array so that elements smaller than the pivot go left and larger ones go right. It then recursively sorts both sides.";
  }

  if (q.includes("linear search")) {
    return "Linear search scans each element one by one from the beginning until it finds the target or reaches the end. It works on unsorted arrays but is slower than binary search for large inputs.";
  }

  if (q.includes("stack")) {
    return "A stack is a data structure that follows Last In First Out order. Push adds an element to the top and Pop removes from the top. It is used in function calls, undo operations, and expression parsing.";
  }

  if (q.includes("queue")) {
    return "A queue follows First In First Out order. Enqueue adds an element to the rear and Dequeue removes from the front. It is used in scheduling, BFS, and task processing.";
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

async function runTimelineLessonPipeline(question, feynmanMode = false) {
  try {
    const plan = await buildStructuredLessonPlan(question.trim(), feynmanMode);
    return validateLessonPlan(plan) || buildFallbackLessonPlan(question.trim());
  } catch (err) {
    console.warn("[Planner] Structured lesson pipeline failed, using fallback:", err.message);
    return buildFallbackLessonPlan(question.trim());
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
app.use(express.json({ limit: '30mb' }));
app.use(express.urlencoded({ extended: true, limit: '30mb' }));

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

app.get("/api/attendance/health", async (req, res) => {
  return proxyAttendanceRequest(res, {
    method: "get",
    url: `${ATTENDANCE_SERVICE_URL}/health`,
  });
});

app.get("/api/attendance/students", async (req, res) => {
  return proxyAttendanceRequest(res, {
    method: "get",
    url: `${ATTENDANCE_SERVICE_URL}/attendance/students`,
  });
});

app.post("/api/attendance/students/register", async (req, res) => {
  return proxyAttendanceRequest(res, {
    method: "post",
    url: `${ATTENDANCE_SERVICE_URL}/attendance/students/register`,
    headers: {
      "Content-Type": "application/json",
    },
    data: req.body,
  });
});

app.post("/api/attendance/live/start", async (req, res) => {
  return proxyAttendanceRequest(res, {
    method: "post",
    url: `${ATTENDANCE_SERVICE_URL}/attendance/live/start`,
    data: req.body,
  });
});

app.post("/api/attendance/live/stop", async (req, res) => {
  return proxyAttendanceRequest(res, {
    method: "post",
    url: `${ATTENDANCE_SERVICE_URL}/attendance/live/stop`,
    data: req.body,
  });
});

app.get("/api/attendance/live/status", async (req, res) => {
  return proxyAttendanceRequest(res, {
    method: "get",
    url: `${ATTENDANCE_SERVICE_URL}/attendance/live/status`,
  });
});

app.get("/api/attendance/records", async (req, res) => {
  return proxyAttendanceRequest(res, {
    method: "get",
    url: `${ATTENDANCE_SERVICE_URL}/attendance/records`,
    params: req.query,
  });
});

app.post("/api/attendance/records/manual", async (req, res) => {
  return proxyAttendanceRequest(res, {
    method: "post",
    url: `${ATTENDANCE_SERVICE_URL}/attendance/records/manual`,
    data: req.body,
  });
});

app.patch("/api/attendance/records/:recordId", async (req, res) => {
  return proxyAttendanceRequest(res, {
    method: "patch",
    url: `${ATTENDANCE_SERVICE_URL}/attendance/records/${req.params.recordId}`,
    data: req.body,
  });
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

  const sendLessonPlan = (plan) => {
    sseWrite(res, {
      type: "lesson_start",
      payload: {
        topic: plan.topic || question.trim(),
        mode: plan.mode,
        template_id: plan.template_id,
      },
    });
    sseWrite(res, { type: "lesson_plan", payload: plan });
    sseWrite(res, { type: "complete" });
    res.end();
  };

  try {
    const plan = await runTimelineLessonPipeline(question.trim(), feynmanMode);
    if (disconnected) return;
    sendLessonPlan(plan);
    return;
  } catch (timelineError) {
    if (!disconnected) {
      console.error("Timeline doubt stream error:", timelineError.message);
      const fallback = buildFallbackLessonPlan(question.trim());
      sendLessonPlan(fallback);
    }
    return;
  }
});

app.post("/api/doubt", async (req, res) => {
  try {
    const { question } = req.body;

    if (!question || typeof question !== "string" || !question.trim()) {
      return res.status(400).json({ success: false, error: "question is required" });
    }

    const data = await runTimelineLessonPipeline(question.trim());
    return res.json({ success: true, data });
  } catch (err) {
    console.error("Doubt API error:", err.message);
    const fallback = buildFallbackLessonPlan(req.body?.question || "Concept");
    return res.json({ success: true, data: fallback, fallback: true });
  }
});

app.get("/api/doubt", async (req, res) => {
  try {
    const question = typeof req.query.q === "string" && req.query.q.trim()
      ? req.query.q.trim()
      : typeof req.query.question === "string" && req.query.question.trim()
        ? req.query.question.trim()
        : "";

    if (!question) {
      return res.status(400).json({
        success: false,
        error: "question is required via ?q=... or ?question=...",
      });
    }

    const data = await runTimelineLessonPipeline(question);
    return res.json({ success: true, data });
  } catch (err) {
    console.error("Doubt GET API error:", err.message);
    const fallback = buildFallbackLessonPlan(
      typeof req.query.q === "string" && req.query.q.trim()
        ? req.query.q.trim()
        : typeof req.query.question === "string" && req.query.question.trim()
          ? req.query.question.trim()
          : "Concept"
    );
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
