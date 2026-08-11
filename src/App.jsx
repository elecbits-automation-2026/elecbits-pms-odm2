/* ═══════════════════════════════════════════════════════════════════════════
   ELECBITS ODM — PROJECT MANAGEMENT SYSTEM
   ───────────────────────────────────────────────────────────────────────────
   Modules (left sidebar):
     1. Create a Project   (admin only) — chat wizard carried from the previous
        ODM tool: client → Client ID → contact → deadline → Project ID
        (auto EbZ format OR manual) → team → Customer LLD (30-Q guided chat OR
        manual upload/paste) → Designer LLD (AI-generated OR manual) → review.
        HARD GATES: no Project ID / Customer LLD / Designer LLD / PM / deadline
        → no project. Below: projects list + status only (no execution here).
     2. Daily Scrum        — date-wise notes; AI organises free text into
        tasks with assignees, time windows and if/else contingency branches.
     3. My Projects & Tasks— group by project or person; Start → work window;
        Complete Now → AI verification interview; branch sub-tasks back to
        scrum as a story; "Escalate to Shreya?" always present.
     4. Performance & Training — PM KPI block with red alerts, daily Work
        Update sheet scored by AI against the KPIs, training assignments.
     5. System Memory      (admin) — templates, instruction sets, previous
        Claude conversations, Drive sitemaps for Project-ID / PCB-ID folders;
        injected into every AI call.
   Integration seams (real deployment): Google Drive/Sheets + Supabase calls
   are simulated here as a visible Sync Log — swap sheetSync() for the edge
   functions in the elecbits-pms codebase.
   ═══════════════════════════════════════════════════════════════════════════ */
import { useState, useEffect, useRef, useMemo, useCallback, createContext, useContext } from "react";
import {
  Plus, X, Play, CheckCircle2, AlertTriangle, GitBranch, Clock, Upload,
  FileText, Send, Sparkles, ChevronDown, Sun, Moon, Bot, GraduationCap,
  RefreshCw, Zap, Users, FolderPlus, NotebookPen, ListChecks, Gauge,
  Database, Calendar, Loader2, Trash2, Shield, ArrowRight, Pencil, Paperclip, Download, Lightbulb, Award, Eye, EyeOff, Search
} from "lucide-react";
import elecbitsLogo from "./assets/elecbits-logo.jpg";
/* The official logo is a JPG on white — in dark mode it sits on a white chip. */
const logoChip = (dark, h) => ({ height: h, width: "auto", display: "block", background: dark ? "#fff" : "transparent", padding: dark ? "5px 9px" : 0, borderRadius: 8, boxSizing: "content-box" });
import { supabase, supabaseEnabled, supabaseConfigured, supabaseUrl, supabaseAnonKey, supabaseInitError } from "./lib/supabase.js";
import { syncAll } from "./lib/tableSync.js";
import { mergeWorkspace, idsOf, baseOf, blobA, blobB } from "./lib/blobMerge.js";
import { getSession, onAuthChange, signIn, signUp, signOut, resetPassword, setPassword, authReturnError, fetchProfiles } from "./lib/auth.js";

/* ─── SMALL HELPERS ─────────────────────────────────────────────────────── */
const uid = () => Math.random().toString(36).slice(2, 10);
/* Roster ids go into a uuid column in Postgres, so they have to BE uuids —
   a short generated id was silently rejected and the resource never saved. */
const uuid = () => (globalThis.crypto?.randomUUID
  ? globalThis.crypto.randomUUID()
  : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
    }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const todayStr = () => new Date().toISOString().slice(0, 10);
const nowHM = () => new Date().toTimeString().slice(0, 5);
const fmtDate = (d) => (d ? new Date(d.length === 10 ? d + "T00:00:00" : d).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }) : "—");
const daysLeft = (d) => Math.ceil((new Date(d + "T23:59:59") - new Date()) / 86400000);
const initials = (n) => (n || "?").split(" ").map((w) => w[0]).join("").slice(0, 2).toUpperCase();
const MONO = "'IBM Plex Mono',monospace";
const hmToDate = (dateStr, hm) => new Date(`${dateStr}T${hm || "23:59"}:00`);
const fmtDur = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60; return (h ? h + ":" : "") + String(m).padStart(2, "0") + ":" + String(ss).padStart(2, "0"); };
const normId = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
/* ─── THE REAL DRIVE ADDRESS ──────────────────────────────────────────────
   One chain, two branches. PMs work out of Project Management, engineers out
   of PCB & Firmware. Everything the OS reads or writes lives under here — no
   guessing at folder names anywhere else in Drive. */
const DRIVE_CHAIN = "Eb-02-ODM/Eb-ODM Execution/Engineering Services";
const PM_ROOT = `/${DRIVE_CHAIN}/Project Management`;
const PCB_ROOT = `/${DRIVE_CHAIN}/PCB & Firmware`;
const pmPath = (id) => `${PM_ROOT}/${id || "<Project ID>"}/`;
const pcbPath = (id) => `${PCB_ROOT}/${id || "<board>"}/`;
/* Which branch a person looks in first. */
const driveScope = (role) => (role === "engineer" ? "pcb" : "pm");
const MD = ({ t }) => { const parts = String(t || "").split("**"); return <span>{parts.map((p, i) => (i % 2 ? <b key={i}>{p}</b> : <span key={i}>{p}</span>))}</span>; };

/* ─── STATUS / THEME ────────────────────────────────────────────────────── */
const STATUSES = [
  { k: "Planning", c: "var(--purple)" },
  { k: "In Progress", c: "var(--blue)" },
  { k: "On Hold", c: "var(--amber)" },
  { k: "Delayed", c: "var(--red)" },
  { k: "Completed", c: "var(--green)" },
];
const statColor = (s) => STATUSES.find((x) => x.k === s)?.c || "var(--txt3)";

const DARK = { "--bg": "#0c0e13", "--s1": "#111520", "--s2": "#161c2a", "--s3": "#1e2740", "--bdr": "#1f2d4a", "--bdr2": "#2a3d60", "--txt": "#e2e8f5", "--txt2": "#7a90b8", "--txt3": "#3d5080", "--acc": "#2563eb", "--green": "#16a34a", "--red": "#dc2626", "--amber": "#d97706", "--blue": "#2563eb", "--purple": "#7c3aed", "--coral": "#ea580c", "--soft": "#16213a" };
const LIGHT = { "--bg": "#f8fafc", "--s1": "#ffffff", "--s2": "#f1f5f9", "--s3": "#e2e8f0", "--bdr": "#e2e8f0", "--bdr2": "#cbd5e1", "--txt": "#1e293b", "--txt2": "#64748b", "--txt3": "#94a3b8", "--acc": "#2563eb", "--green": "#16a34a", "--red": "#dc2626", "--amber": "#d97706", "--blue": "#2563eb", "--purple": "#7c3aed", "--coral": "#ea580c", "--soft": "#eff6ff" };

/* ─── CODES (carried from the previous ODM tool) ────────────────────────── */
const INDUSTRY_CODES = [["Electric Vehicle","01"],["EMS","02"],["Just IoT","03"],["IIoT","04"],["Home Automation","05"],["Medical & Healthcare","06"],["Energy Meter & Metering","07"],["Wearables","08"],["Camera & Opticals","09"],["Agri/Farm/Food Tech","10"],["AR/VR/AI","11"],["EdTech","12"],["Industrial/Machine Setup","13"],["ERP Solutions","14"],["Robotics","15"],["Information Technology","16"],["Defence/Military","17"],["Automotive","18"],["Battery Manufacturer","19"],["Consumer Electronics","20"],["Other","21"],["Government & Alliance","22"],["Freelance/Individual","23"],["Logistics/Fleet","24"],["Fintech","25"],["Aerospace","26"],["BLDC","27"],["Renewables","28"],["Oil & Gas","29"],["Smart Home","30"],["Research","31"],["E-Mobility","32"],["Infrastructure","33"],["Toys and Games","34"],["Incubator","35"],["Security/Surveillance","36"],["Components Mfg","37"],["Drone Tech","38"],["Solar","39"],["IT Hardware","40"],["Display Manufacturers","41"],["Industrial Applications","42"]].map(([label, code]) => ({ label, code }));
const ORG_SIZES = [
  { label: "Proto Level — Small Hardware Startups", code: "PL" },
  { label: "Mid Level — Hardware Startups", code: "ML" },
  { label: "Enterprise — Large Product Companies", code: "EL" },
  { label: "EMS", code: "EM" },
  { label: "Individuals / Unknown", code: "UN" },
  { label: "Government Organisation", code: "GO" },
];
const TEAM_SLOTS = ["PM (Project Manager)", "Senior PM (Technical Manager)", "Sr. Hardware Engineer", "Jr. Hardware Engineer", "Sr. Firmware Engineer", "Jr. Firmware Engineer", "Industrial Designer", "Tester / QA", "Supply Chain", "Solution Architect"];

/* ─── LLD QUESTIONS (30 — carried from the previous ODM tool) ───────────── */
const LLD_QUESTIONS = [
  { id: 1, sec: "Product", text: "What is the product you want to build? Describe it in one sentence.", hint: "This becomes the one-liner on every internal doc. Keep it tight.", type: "text" },
  { id: 2, sec: "Product", text: "What category does it fall into?", hint: "Helps us assign the right engineering team from the start.", type: "chips", chips: ["Consumer Electronics", "Industrial IoT", "Medical Device", "Automotive", "Wearable", "Smart Home", "Agriculture", "Robotics", "Other"] },
  { id: 3, sec: "Product", text: "What problem does it solve for the end user?", hint: "The clearer the pain point, the better we can prioritise features.", type: "text" },
  { id: 4, sec: "Product", text: "Who is the target user?", hint: "Affects enclosure rating, UI complexity and compliance path.", type: "chips", chips: ["B2B — Enterprise", "B2B — SME", "B2C — Consumer", "B2G — Government", "Internal use", "Other"] },
  { id: 5, sec: "Product", text: "Any existing products or references we should study?", hint: "A reference product saves weeks of back-and-forth on specs.", type: "text" },
  { id: 6, sec: "Functions", text: "List the key features / functions this product must have.", hint: "These become the acceptance criteria for every milestone.", type: "text" },
  { id: 7, sec: "Functions", text: "Which sensors or input devices are needed?", hint: "Sensor selection drives PCB size, power budget and BOM cost.", type: "text" },
  { id: 8, sec: "Functions", text: "What outputs / actuators are required?", hint: "Motor drivers, relays, LEDs — all affect power architecture.", type: "chips", chips: ["LEDs / Display", "Motor / Actuator", "Speaker / Buzzer", "Relay", "Solenoid", "Heating element", "Pump", "None", "Other"] },
  { id: 9, sec: "Functions", text: "Does it need a user interface?", hint: "Determines display, buttons, or touch controller on the PCB.", type: "chips", chips: ["Physical buttons only", "LCD / OLED screen", "Touchscreen", "Mobile app only", "Voice control", "LED indicators only", "No UI", "Other"] },
  { id: 10, sec: "Functions", text: "Any special processing needs (AI/ML, real-time, high-speed data)?", hint: "This decides the MCU/SoC tier — cost jumps with AI.", type: "text" },
  { id: 11, sec: "Connectivity", text: "What wireless connectivity is needed?", hint: "Each radio adds an antenna, cert path and power draw.", type: "text" },
  { id: 12, sec: "Connectivity", text: "Select all wireless protocols required:", hint: "Multi-protocol combos (Wi-Fi + BLE) need combo modules.", type: "chips", multi: true, chips: ["Wi-Fi", "Bluetooth / BLE", "LoRa", "Zigbee", "Z-Wave", "Cellular (4G/5G)", "NFC", "GPS", "Thread", "None"] },
  { id: 13, sec: "Connectivity", text: "Any wired interfaces needed?", hint: "Connector count affects enclosure sealing and cost.", type: "chips", chips: ["USB-C", "Ethernet", "RS-485", "CAN bus", "UART / Serial", "I2C / SPI (internal)", "HDMI", "Audio jack", "None"] },
  { id: 14, sec: "Connectivity", text: "Does it need cloud connectivity or a backend?", hint: "Cloud adds firmware OTA, security certs and server costs.", type: "chips", chips: ["Yes — custom cloud", "Yes — AWS IoT", "Yes — Azure IoT", "Yes — Google Cloud", "Yes — Elecbits platform", "No cloud needed", "TBD"] },
  { id: 15, sec: "Power", text: "How will the device be powered?", hint: "Battery vs mains changes the entire power tree design.", type: "chips", chips: ["Battery only", "Mains (AC adapter)", "USB powered", "Solar", "PoE", "Battery + charging", "Multiple sources", "TBD"] },
  { id: 16, sec: "Power", text: "If battery-powered, what is the expected battery life?", hint: "Drives sleep-mode firmware architecture and components.", type: "text" },
  { id: 17, sec: "Power", text: "Any power consumption constraints or targets?", hint: "Thermal limits in sealed enclosures are a common late surprise.", type: "text" },
  { id: 18, sec: "Power", text: "Does it need power-saving / sleep modes?", hint: "Deep-sleep firmware is non-trivial — better to plan early.", type: "chips", chips: ["Yes — critical", "Yes — nice to have", "No — always on", "TBD"] },
  { id: 19, sec: "Software", text: "Is there a companion mobile or web app?", hint: "App development is often 40% of the project timeline.", type: "chips", chips: ["Mobile app (iOS + Android)", "Mobile app (Android only)", "Mobile app (iOS only)", "Web dashboard", "Both mobile + web", "No app needed", "TBD"] },
  { id: 20, sec: "Software", text: "Does the firmware need OTA update capability?", hint: "OTA needs a bootloader, dual-partition flash and signing infra.", type: "chips", chips: ["Yes — essential", "Nice to have", "No", "TBD"] },
  { id: 21, sec: "Software", text: "Any data logging, analytics or reporting requirements?", hint: "Determines on-device storage and cloud pipeline design.", type: "chips", chips: ["Real-time telemetry", "On-device logging", "Cloud analytics dashboard", "Exportable reports", "Edge analytics", "No data requirements", "TBD"] },
  { id: 22, sec: "Physical", text: "Approximate size constraints? (L × W × H in mm, or describe)", hint: "PCB dimensions are locked early — changes are expensive later.", type: "text" },
  { id: 23, sec: "Physical", text: "What environment will it operate in?", hint: "IP rating, conformal coating and connectors depend on this.", type: "chips", chips: ["Indoor — controlled", "Indoor — dusty/humid", "Outdoor — sheltered", "Outdoor — exposed", "Underwater", "Hazardous / explosive", "Wearable (on body)", "Vehicle-mounted", "Other"] },
  { id: 24, sec: "Physical", text: "Enclosure material preference?", hint: "Tooling cost varies 10x between 3D-print and injection mould.", type: "chips", chips: ["Plastic (injection mould)", "Metal (aluminium/steel)", "3D printed (prototype)", "Silicone / rubber", "No enclosure (board only)", "TBD"] },
  { id: 25, sec: "Certs", text: "Select all required certifications:", hint: "Cert requirements lock design choices at schematic stage.", type: "chips", multi: true, chips: ["CE", "FCC", "UL", "BIS (India)", "RoHS", "REACH", "IP rating", "MIL-STD", "IEC 60601 (Medical)", "ISO 13485", "Automotive (AEC-Q)", "None yet", "TBD"] },
  { id: 26, sec: "Certs", text: "Any regulatory or compliance notes we should know about?", hint: "Country-specific rules (e.g. India BIS) can add months.", type: "text" },
  { id: 27, sec: "Cost & Time", text: "What is the target unit cost (BOM) range?", hint: "Sets the ceiling for component and PCB layer choices.", type: "chips", chips: ["< ₹500", "₹500 – ₹2,000", "₹2,000 – ₹5,000", "₹5,000 – ₹15,000", "₹15,000+", "No target yet"] },
  { id: 28, sec: "Cost & Time", text: "Expected production volume in the first year?", hint: "Drives tooling investment and supplier MOQ negotiations.", type: "text" },
  { id: 29, sec: "Cost & Time", text: "Any hard deadline or launch date we must hit?", hint: "Expo, funding round or seasonal window — we need to know now.", type: "text" },
  { id: 30, sec: "Cost & Time", text: "Anything else we should know? Risks, constraints, special requests…", hint: "Better to over-share than discover surprises later.", type: "text" },
];

/* ─── SEED DATA ─────────────────────────────────────────────────────────── */
/* Real Elecbits team (from the org roster). IDs are the real profile UUIDs so
   they line up with Supabase once connected. "Admin" is a demo-only account. */
const ROLE_TITLE = { jr_pm: "Jr. Project Manager", sr_pm: "Sr. Project Manager", jr_fw: "Jr. Firmware Engineer", sr_fw: "Sr. Firmware Engineer", jr_hw: "Jr. Hardware Engineer", sr_hw: "Sr. Hardware Engineer", sc: "Supply Chain", ind_design: "Industrial Designer", sol_arch: "Solution Architect", admin: "Super Admin", tester: "Tester / QA", devops: "DevOps Engineer", soldering: "Soldering & Testing" };
const _PALETTE = ["#2563eb", "#7c3aed", "#ea580c", "#0891b2", "#16a34a", "#d97706", "#db2777", "#0d9488", "#9333ea", "#dc2626", "#4f46e5", "#0284c7", "#059669", "#b45309", "#c026d3", "#e11d48", "#1e3a8a", "#65a30d", "#4338ca", "#be123c"];
const _TEAM = [
  ["u-admin", "Admin", "admin@elecbits.in", "superadmin", "admin", "Super Admin"],
  ["3d6cfb19-1c1c-4d81-b25c-a0631458d955", "Shreya", "shreya@elecbits.in", "superadmin", "sr_pm", "Dept Head — Project Management"],
  ["9e0c0a11-72df-449d-8aba-0844a69f07e0", "Saurav", "saurav@elecbits.in", "superadmin", "sr_pm", "Dept Head — Project Management"],
  ["fba02f3c-0a59-42c6-a78e-8b613a4876ba", "Nikhil", "nikhil@elecbits.in", "superadmin", "sol_arch", "Dept Head — Solution Architecture"],
  ["2222f3cd-340b-47be-8424-e9b427d9700c", "Jerom Johnshibu", "jerom.johnshibu@elecbits.in", "pm", "jr_pm"],
  ["418b539b-d7e9-4a40-8e04-d4eff407a6a0", "Chhavi Bhatia", "chhavi.bhatia@elecbits.in", "pm", "jr_pm"],
  ["902d6d92-fc01-408c-b933-19c04541f254", "Gargi Sharma", "gargi.sharma@elecbits.in", "pm", "jr_pm"],
  ["bda57b8b-94f2-4e1c-98a2-85e07e78ba6e", "Nived P", "nived.p@elecbits.in", "pm", "jr_pm"],
  ["df5cc7c0-1eff-424b-9996-57aacc27a33d", "Anunay Dixit", "anunay.dixit@elecbits.in", "pm", "sr_pm"],
  ["852cdee8-1e4f-43e2-aec1-afe034e8e62b", "AXS", "axs@elecbits.in", "pm", "sr_hw"],
  ["540cc7a6-895a-433e-9364-1c5b4fae3732", "Rahul Singh", "rahul.singh@elecbits.in", "engineer", "jr_hw"],
  ["4710aed6-904f-4a0c-b9ce-613b9174114c", "Yogesh", "yogesh@elecbits.in", "engineer", "jr_hw"],
  ["c8cda154-e0f9-4d62-86db-03a0851f8a37", "Ankit Ashok Mishra", "ankit.ashokmishra@elecbits.in", "engineer", "jr_hw"],
  ["cda383fc-b4fd-475d-9153-966a77511108", "Jeena George", "jeena.george@elecbits.in", "engineer", "jr_hw"],
  ["92db0288-7def-4051-8354-2cfb14670a09", "Arun Mohan", "arun.mohan@elecbits.in", "engineer", "sr_hw"],
  ["2b470c12-1377-4f70-b4d3-5b54e4438d64", "Amitabh Gogoi", "amitabh.gogoi@elecbits.in", "engineer", "sr_fw"],
  ["22632c31-57b3-4da1-8611-19f3f4ba3944", "Aneesh Madhavan", "aneesh.madhavan@elecbits.in", "engineer", "jr_fw"],
  ["2c30777b-ea66-4469-9e3a-3d697f259ca7", "Vishnu Vardhan", "vishnu.vardhan@elecbits.in", "engineer", "jr_fw"],
  ["2ed42335-7f17-4f41-a8a0-d29544902d64", "Swati Saxena", "swati.saxena@elecbits.in", "engineer", "jr_fw"],
  ["72faf88c-6f2a-460c-b6cb-3ab132373f4d", "Sonu Kumar", "sonu.kumar@elecbits.in", "engineer", "jr_fw"],
  ["7c4e90f4-49bf-4b62-86df-4bce08e7baaf", "Sai Kiran", "sai.kiran@elecbits.in", "engineer", "jr_fw"],
  ["86b494a0-cabe-4007-83a7-980a8a5eca27", "Israfil Khan", "israfil.khan@elecbits.in", "engineer", "jr_fw"],
  ["90fc23c7-3b3c-4d87-a537-3c2959aef5d2", "Ayesha Sheik", "sheik.ayesha@elecbits.in", "engineer", "jr_fw"],
  ["da82cf31-85bc-479f-ad0f-8b8321cd55c6", "Nethravathi GK", "nethravathi.gk@elecbits.in", "engineer", "jr_fw"],
  ["52546bb1-89f3-4a59-aa5e-b3badb3f2376", "Harshal Vaishampayan", "harshal.vaishampayan@elecbits.in", "engineer", "sc"],
  ["db9654f0-0b7e-4d3f-b6ed-3fd69ab781db", "Anwer Suhail", "anwer.suhail@elecbits.in", "engineer", "ind_design"],
];
const SEED_USERS = _TEAM.map(([id, name, email, role, rr, titleOverride], i) => ({ id, name, email, role, title: titleOverride || ROLE_TITLE[rr] || "Team", resourceRole: rr, color: _PALETTE[i % _PALETTE.length] }));
const SHREYA_ID = "3d6cfb19-1c1c-4d81-b25c-a0631458d955";
const seedDeadline = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
const SEED_CLIENTS = [{ id: "c-seed", clientId: "PL20-001", name: "Acme Devices" }];
const SEED_PROJECTS = [{
  id: "p-seed1", projectId: "ESP32-123", idMode: "manual", name: "ESP32 Sensor Node",
  clientName: "Acme Devices", clientId: "PL20-001", industry: "Consumer Electronics", orgSize: "Proto Level",
  contact: { name: "Rajesh Kumar", designation: "CTO", phone: "+91 98000 00000", email: "rajesh@acme.dev" },
  deadline: seedDeadline, status: "In Progress",
  team: [
    { slot: "PM (Project Manager)", userId: "902d6d92-fc01-408c-b933-19c04541f254" },
    { slot: "Jr. Hardware Engineer", userId: "540cc7a6-895a-433e-9364-1c5b4fae3732" },
    { slot: "Jr. Hardware Engineer", userId: "4710aed6-904f-4a0c-b9ce-613b9174114c" },
    { slot: "Jr. Firmware Engineer", userId: "72faf88c-6f2a-460c-b6cb-3ab132373f4d" },
  ],
  lldCustomer: { mode: "manual", text: "ESP32-based environmental sensor node. Wi-Fi + BLE, battery powered (2000 mAh, 6-month target), 4-layer PCB, IP54 enclosure, BIS + CE targeted. Cloud dashboard on Elecbits platform, OTA essential.", fileName: "" },
  lldDesigner: { mode: "manual", text: "MCU: ESP32-WROOM-32E. Power: Li-ion + TP4056 charge + 3.3 V buck (TPS62840). Sensors: SHT40 (T/RH), BMP390 (pressure) on shared I2C. Interfaces: USB-C via CP2102N, tag-connect for JTAG. FW: ESP-IDF, dual-partition OTA. Test hooks: UART pads, current-sense jumper on VBAT.", fileName: "" },
  createdAt: new Date(Date.now() - 3 * 86400000).toISOString(), createdBy: "u-admin",
}];
const SEED_MEMORY = [
  { id: "m1", type: "sitemap", title: "Drive sitemap — where everything lives", content: `Every project folder sits under one chain:\n${PM_ROOT}/<Project ID>/        ← project managers work here\n${PCB_ROOT}/<board folder>/     ← hardware and firmware engineers work here\nNothing outside this chain belongs to a project. Always start from here, then look inside.`, createdAt: new Date().toISOString() },
  { id: "m2", type: "sitemap", title: "Finding things inside a project folder", content: "File names are NOT consistent — do not expect a fixed name for anything. Inside a project folder there may be a checklist or tracker, reports, client communication, LLDs, gerbers, BoMs, schematics and test reports, in sub-folders or loose, named however the person who made them felt like naming them.\nSo: look at everything in the folder and its sub-folders, read what looks relevant, and answer from what is actually in there. Never say a file is missing because it does not have the name you expected.", createdAt: new Date().toISOString() },
  { id: "m3", type: "instruction", title: "Task quality bar", content: "Every closed task must name the exact file produced and its Drive path. Gerber checks require a DRC report. BoM checks require the availability + alternates columns filled. A task without a stored artifact is not a finished task.", createdAt: new Date().toISOString() },
];
const KPI_DEFS = "PM KPIs (daily): (1) Customer queries answered — every client question closed same day, minimum 3 logged; (2) Decisions taken that move the project to completion — minimum 5/day; (3) Team on-time — every R&D member on the PM's projects finishes tasks on time (≥70%); (4) AI-checked closures — task completions verified through the AI gate; (5) Escalations to Shreya (Dept Head) — the fewer decisions that reach her, the better; target 0–1/day.";
const KPI_T = { queries: 3, decisions: 5, onTime: 70, escalations: 1 };

/* ─── AI LAYER ──────────────────────────────────────────────────────────────
   Integration seam. By default this posts to the Anthropic Messages API — in
   the artifact sandbox the host injects auth; in a real browser that call is
   unauthenticated and every caller here falls back to an offline parser, so
   the app still runs end-to-end. For live Claude in a real deployment set
   VITE_CLAUDE_PROXY_URL to your own backend proxy (recommended — keeps the key
   server-side), or, for local dev only, VITE_ANTHROPIC_API_KEY.               */
const AI_MODEL = import.meta.env.VITE_CLAUDE_MODEL || "claude-sonnet-4-5";
/* Google Drive endpoints (Supabase Edge Functions). Empty → the Sync Log stays
   local-only and Drive analysis reasons over the folder map instead of real
   contents. Set VITE_DRIVE_SYNC_URL (writes) and VITE_DRIVE_READ_URL (reads). */
const DRIVE_SYNC_URL = import.meta.env.VITE_DRIVE_SYNC_URL || "";
const DRIVE_READ_URL = import.meta.env.VITE_DRIVE_READ_URL || "";
const DRIVE_READ_TOKEN = import.meta.env.VITE_DRIVE_READ_TOKEN || "";
/* Fetch the real contents of the project's Drive folders. Works with either
   backend: the drive-read Supabase Edge Function (service account) or the
   Google Apps Script web app (runs as you — no service-account key needed).
   Sent as text/plain so the browser skips the CORS preflight that Apps Script
   can't answer; both backends parse the JSON body regardless. Returns a text
   digest for prompts, or "" when unavailable. */
/* Returns { digest, error } — the caller shows `error` so a misconfigured Drive
   function explains itself instead of silently degrading. */
async function driveReadDigest(projectId, linkedIds, opts = {}) {
  if (!DRIVE_READ_URL) return { digest: "", error: "" };
  // A search with no project named is a real question — "find the project
  // tracker", "which folders have an audit checklist". This used to return
  // empty without ever calling Drive, which is why those answers were always
  // "I couldn't open anything".
  if (!projectId && !(linkedIds || []).length && !String(opts.search || "").trim()) {
    return { digest: "", error: "" };
  }
  // The reader works to its own 20s budget; give up at 40 so a stalled call
  // can never leave the page spinning on "Analysing…".
  const ctrl = new AbortController();
  const bail = setTimeout(() => ctrl.abort(), 40000);
  try {
    const res = await fetch(DRIVE_READ_URL, {
      method: "POST",
      signal: ctrl.signal,
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      // scope picks which branch to look in first; search tells the reader what
      // to hunt for inside the folder, since file names are never consistent.
      body: JSON.stringify({ projectId, linkedIds: linkedIds || [], token: DRIVE_READ_TOKEN, userJwt: await userJwt(), scope: opts.scope || "pm", search: opts.search || "" }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      // Prefer the server's own message — the function returns the real Google
      // error (bad key, folder not shared, API disabled) in the body.
      const serverMsg = data.error || data.message || data.msg;
      const hint = serverMsg
        || (res.status === 401 ? "unauthorized — turn Verify JWT off, or check the token"
          : res.status === 404 ? "function not found — check VITE_DRIVE_READ_URL"
          : res.status === 504 || res.status === 408 ? "Drive took too long — the folder is very large. Ask about one project or one board at a time."
          : res.status >= 500 ? `the Drive reader errored (${res.status}) — check the function's Logs`
          : `${res.statusText || "error"} — check the function's Logs`);
      return { digest: "", error: `Drive read failed (${res.status}): ${String(hint).slice(0, 220)}` };
    }
    if (data.error) return { digest: "", error: `Drive read: ${data.error}` };
    // An empty digest with a 200 is the confusing case — Drive answered, but
    // there is nothing to show. Say which of the three reasons it is instead
    // of shrugging. `root` only comes back from the current reader, so its
    // absence is itself the diagnosis.
    if (!String(data.digest || "").trim()) {
      const stale = !("root" in data);
      return {
        digest: "",
        error: stale
          ? "The Drive reader running on the server is an older build that can't search — redeploy supabase/functions/drive-read and try again."
          : !data.root
            ? `I reached Drive but couldn't find ${DRIVE_CHAIN} — the service account can't see that folder. Share it with the service-account address (Editor) and try again.`
            : "",
        searchedRoot: data.root || "",
      };
    }
    // No second truncation here — the reader already budgets the digest per
    // folder. Cutting it again dropped whatever came last, which is why linked
    // board folders kept looking empty.
    return { digest: String(data.digest || ""), error: "" };
  } catch (e) {
    if (e?.name === "AbortError") return { digest: "", error: "Drive took too long to answer — try again, or ask about one project at a time." };
    return { digest: "", error: `Drive unreachable: ${e.message || e}` };
  } finally {
    clearTimeout(bail);
  }
}
/* Write a file into the project's Drive folder (needs the folder shared with
   the service account as Editor). Plain text by default; pass base64 + a mime
   type to push a real binary — a PDF, a spec sheet, a photo of a board.
   Returns true on success. */
/* Returns true on success, or a short human reason on failure — a blanket
   "Drive isn't reachable" hid real causes like a folder that isn't shared. */
/* Browse a folder. Searching and browsing are different questions — "what is
   in Eb-02-ODM" deserves a listing, not a keyword hunt. */
async function driveListFolder(folderPath) {
  if (!DRIVE_READ_URL) return { listing: "", error: "Drive isn't connected in this build." };
  const ctrl = new AbortController();
  const bail = setTimeout(() => ctrl.abort(), 40000);
  try {
    const res = await fetch(DRIVE_READ_URL, {
      method: "POST", signal: ctrl.signal,
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ action: "list", folderPath: folderPath || "", token: DRIVE_READ_TOKEN, userJwt: await userJwt() }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) {
      return { listing: "", error: data.error || `Drive wouldn't list that (${res.status}).` };
    }
    if (!("listing" in data)) {
      return { listing: "", error: "The Drive reader on the server is an older build that can't browse folders — redeploy supabase/functions/drive-read." };
    }
    return { listing: data.listing || "", error: "", path: data.path || "" };
  } catch (e) {
    return { listing: "", error: e?.name === "AbortError" ? "Drive took too long to answer." : "Drive isn't reachable right now." };
  } finally { clearTimeout(bail); }
}

/* The signed-in person's Supabase access token. Sent with Drive calls so the
   function can create files AS THEM — owned by them, their name on "Last
   modified by" — instead of as one shared robot account. It travels in the
   body rather than a header on purpose: the request is text/plain so it needs
   no CORS preflight, and the token is verified server-side either way. */
async function userJwt() {
  if (!supabaseEnabled) return "";
  try { const s = await getSession(); return s?.access_token || ""; } catch { return ""; }
}

async function driveWriteFile(projectId, fileName, content, opts = {}) {
  if (!DRIVE_READ_URL) return "Drive isn't connected in this build.";
  if ((!projectId && !opts.folderPath) || !fileName) return "I need somewhere to put it and a file name.";
  // A big file takes as long as it takes — roughly a second per megabyte on a
  // modest connection, on top of the reader's own budget.
  const mb = String(content || "").length / 1048576;
  const ctrl = new AbortController();
  const bail = setTimeout(() => ctrl.abort(), Math.min(360000, 45000 + mb * 4000));
  try {
    const res = await fetch(DRIVE_READ_URL, {
      method: "POST",
      signal: ctrl.signal,
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ action: "write", projectId, fileName, content, token: DRIVE_READ_TOKEN, userJwt: await userJwt(), ...(opts.folderPath ? { folderPath: opts.folderPath } : {}), ...(opts.encoding ? { encoding: opts.encoding } : {}), ...(opts.mimeType ? { mimeType: opts.mimeType } : {}), scope: opts.scope || "pm" }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.ok) return true;
    if (res.status === 413) return `${fileName} is too large for the upload to accept. Put it in the Drive folder directly.`;
    const why = data.error || data.message || `${res.status} ${res.statusText || ""}`.trim();
    return String(why).slice(0, 180);
  } catch (e) {
    return e?.name === "AbortError" ? `${fileName} took too long to upload — try a smaller file, or put it in the Drive folder directly.` : `Drive unreachable: ${e.message || e}`;
  } finally {
    clearTimeout(bail);
  }
}
/* Every caller wants the same shape: did it save, and if not, why. Failures
   are squeezed onto one plain line — a raw Google JSON blob in the middle of a
   conversation helps nobody. */
const tidyReason = (r) => {
  let t = String(r || "").replace(/^Error:\s*/i, "").trim();
  if (t.startsWith("{") || t.includes('"error"')) {
    const m = t.match(/"message"\s*:\s*"([^"]+)"/);
    t = m ? m[1] : "Drive refused it";
  }
  t = t.replace(/\s+/g, " ").trim();
  if (t.length > 150) t = `${t.slice(0, 147)}…`;
  return t || "Drive refused it";
};
const saveResult = (r, fileName, where) =>
  r === true ? `Saved ${fileName} into the ${where} folder in Drive.` : `Couldn't save ${fileName} — ${tidyReason(r)}`;

/* ── ATTACHMENTS ───────────────────────────────────────────────────────────
   Anything the user drops into a chat. Text-ish files are read straight in so
   the AI can act on their contents; everything else is carried as base64 and
   can be pushed into a project's Drive folder, where the Drive reader will
   pull the text back out of it on the next look. */
const TEXTY = /\.(txt|md|markdown|csv|tsv|json|xml|ya?ml|log|html?|css|js|jsx|ts|tsx|py|c|h|cpp|ino|sh|sql|ini|cfg|conf|net|bom)$/i;
const MAX_ATTACH = 50 * 1024 * 1024;
/* Only worth reading a text file into the conversation if it is small — the
   prompt takes the first 20k characters anyway, and a huge one just burns
   memory. Anything bigger rides along as a file to be filed in Drive. */
const MAX_INLINE_TEXT = 2 * 1024 * 1024;
const readAttachment = (file) => new Promise((resolve) => {
  const base = { id: uid(), name: file.name, mime: file.type || "application/octet-stream", size: file.size };
  if (file.size > MAX_ATTACH) return resolve({ ...base, tooBig: true });
  const r = new FileReader();
  if ((TEXTY.test(file.name) || /^text\//.test(file.type)) && file.size <= MAX_INLINE_TEXT) {
    r.onload = () => resolve({ ...base, text: String(r.result).slice(0, 20000) });
    r.onerror = () => resolve({ ...base, failed: true });
    r.readAsText(file);
  } else {
    r.onload = () => {
      const url = String(r.result);
      resolve({ ...base, b64: url.split(",")[1] || "", ...(/^image\//.test(base.mime) ? { preview: url } : {}) });
    };
    r.onerror = () => resolve({ ...base, failed: true });
    r.readAsDataURL(file);
  }
});
const kb = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
/* A screenshot pasted straight into a chat arrives as a nameless blob — give
   it a real name so it can be filed in Drive like any other attachment. */
const filesFromPaste = (e) => {
  const items = [...(e.clipboardData?.items || [])];
  const out = [];
  let n = 0;
  for (const it of items) {
    if (it.kind !== "file") continue;
    const f = it.getAsFile();
    if (!f) continue;
    // Chrome hands every pasted screenshot the same name ("image.png"), so a
    // second one would quietly replace the first in Drive. Stamp them instead.
    if (/^image\//.test(f.type)) {
      const ext = (f.type.split("/")[1] || "png").replace("jpeg", "jpg").replace("svg+xml", "svg");
      out.push(new File([f], `pasted-image-${todayStr()}-${nowHM().replace(":", "")}${n++ ? `-${n}` : ""}.${ext}`, { type: f.type }));
    } else out.push(f);
  }
  return out;
};
/* Shared by every chat's paperclip button and drop zone. */
const pickAttachments = async (fileList, setAtts, toast) => {
  const files = [...(fileList || [])].slice(0, 5);
  if (!files.length) return;
  const read = await Promise.all(files.map(readAttachment));
  setAtts((a) => [...a, ...read].slice(0, 5));
  const big = read.filter((r) => r.tooBig);
  if (big.length) toast(`${big[0].name} is over 50 MB — too big to attach`, "amber");
};
/* Push one read attachment into a project's Drive folder, as-is. */
const saveAttachmentToDrive = (att, projectId, scope) =>
  att.b64 != null
    ? driveWriteFile(projectId, att.name, att.b64, { encoding: "base64", mimeType: att.mime, scope })
    : driveWriteFile(projectId, att.name, att.text || "", { mimeType: "text/plain", scope });
/* Download a chat-created document to the person's computer. */
const downloadDoc = (doc) => {
  const ext = String(doc.fileName || "").split(".").pop()?.toLowerCase() || "md";
  const type = ext === "csv" ? "text/csv" : ext === "html" ? "text/html" : "text/markdown";
  const url = URL.createObjectURL(new Blob([doc.content || ""], { type }));
  const a = document.createElement("a");
  a.href = url; a.download = doc.fileName || "document.md";
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
};
/* What the model is told about the files in front of it. `fresh` is false when
   the files came in on an earlier turn but are still in hand — the model must
   still be able to act on them ("actually, keep that one"). */
const attachCtx = (atts, fresh = true) => !atts?.length ? "" : `\n${fresh ? "FILES THE USER JUST ATTACHED" : "FILES THEY ATTACHED EARLIER IN THIS CONVERSATION — still in your hands, you can still read them or file them away"} — treat these as documents you have open in front of you:\n${atts.map((a) => a.tooBig
  ? `- ${a.name} (${kb(a.size)}) — too big to open here; ask them to put it in the project folder instead.`
  : a.text != null
    ? `- ${a.name} (${kb(a.size)}), contents:\n"""${a.text}"""`
    : /^image\//.test(a.mime)
      ? `- ${a.name} (${kb(a.size)}) — a screenshot they pasted. THE PICTURE ITSELF IS ATTACHED TO THIS MESSAGE: look at it and answer from what you can see. Never say you cannot see an image.`
      : `- ${a.name} (${kb(a.size)}, ${a.mime}) — a document they handed you. You have not stored it anywhere yet. If it belongs in a project folder, use save_attachment with that project's ID, and after it is saved you can read what is inside it.`).join("\n")}\n`;
/* Tries the proxy first (key stays server-side), then the direct browser key —
   so a configured-but-undeployed proxy no longer silently kills live AI. */
/* Anthropic takes images as content blocks alongside the text. Sending only
   the file NAME was why the assistant kept saying it could not see a
   screenshot — the bytes were sitting in the browser the whole time. */
const IMG_OK = ["image/jpeg", "image/png", "image/gif", "image/webp"];
/* PDFs go to the model as documents it can actually read. Spreadsheets are
   turned into rows first — the API takes text, and rows are what matter. */
const docBlocks = (atts) => (atts || [])
  .filter((a) => a && a.b64 && a.mime === "application/pdf" && !a.tooBig)
  .slice(0, 3)
  .map((a) => ({ type: "document", source: { type: "base64", media_type: "application/pdf", data: a.b64 } }));

/* What to show while a step is running, in the person's language. */
const stepLabel = (name, input) => {
  const i = input || {};
  switch (name) {
    case "read_drive": return `Looking in Drive${i.projectId ? ` at ${i.projectId}` : i.search ? ` for "${String(i.search).slice(0, 40)}"` : ""}…`;
    case "write_drive_file": return `Writing ${i.fileName} into ${i.folderPath || i.projectId}…`;
    case "save_attachment": return `Filing ${i.name} into ${i.projectId}…`;
    case "list_projects": return "Checking the project list…";
    case "list_folder": return `Opening ${i.folderPath || "Eb-02-ODM"} in Drive…`;
    case "create_project": return `Creating ${i.projectId || i.name || "the project"}…`;
    case "update_project": return `Updating ${i.projectId}…`;
    case "delete_projects": return "Working out what to delete…";
    case "add_task": return `Raising "${String(i.title || "").slice(0, 40)}"…`;
    case "update_task": return "Updating the task…";
    case "assign_resource": return `Putting ${i.name} on ${i.projectId}…`;
    case "unassign_resource": return `Taking ${i.name} off ${i.projectId}…`;
    case "add_resource": return `Adding ${i.name} to the team…`;
    case "add_scrum_note": return "Writing the scrum note…";
    case "add_memory": return "Committing that to memory…";
    case "list_memory": return "Reading the standing rules…";
    case "update_memory": return "Rewriting a standing rule…";
    case "delete_memory": return "Dropping a standing rule…";
    case "assign_training": return `Assigning training to ${i.name}…`;
    default: return "Working…";
  }
};

const imageBlocks = (atts) => (atts || [])
  .filter((a) => a && a.b64 && IMG_OK.includes(a.mime) && !a.tooBig)
  .slice(0, 4)                                   // the API caps what is useful
  .map((a) => ({ type: "image", source: { type: "base64", media_type: a.mime, data: a.b64 } }));

/* ── THE AGENT LOOP ────────────────────────────────────────────────────────
   Everything before this was one shot: ask the model, parse whatever it wrote,
   run it, stop. That is why it could not chase a thread — find the tracker,
   read it, then create the projects it lists — without being nudged at every
   step.

   This is the real thing. The model is given actual tools, calls them, sees
   what came back, and decides what to do next, round after round, until it has
   finished the job and says so. The workspace tools and Anthropic's own
   server-side ones (web search, code execution) sit side by side, so a single
   question can cross the internet, a spreadsheet and the project list without
   coming back to ask permission to continue.                                  */
const MAX_STEPS = 10;                      // a runaway guard, not a work limit
const SERVER_TOOLS = [
  { type: "web_search_20250305", name: "web_search", max_uses: 6 },
  { type: "code_execution_20250522", name: "code_execution" },
];
/* code execution is a beta; the header is harmless when the tool is unused */
const AGENT_BETA = "code-execution-2025-05-22";

const tool = (name, description, properties, required = []) =>
  ({ name, description, input_schema: { type: "object", properties, required } });
const str = (description) => ({ type: "string", description });
const strs = (description) => ({ type: "array", items: { type: "string" }, description });

const WORKSPACE_TOOLS = [
  tool("read_drive", "Look inside the company's Google Drive. Give a projectId to open that project's folders, or a search phrase to hunt across the whole ODM tree. Returns the folder listing and the text inside the files. Use it before answering anything about what exists, what a checklist says, or what state a board is in.",
    { projectId: str("the project whose folders to open, e.g. Eb-09-ML-432-01-1752"), search: str("what to hunt for when no project is named, e.g. 'project tracker'") }),
  tool("create_doc", "Write a document and hand it to the user in the chat — a plan, a checklist, a summary, a report, a CSV. They can open it, download it, and it is filed into the project's Drive folder if you name one. Use this whenever they ask you to write, draft, produce or prepare something, rather than dumping the text into your reply.",
    { title: str("what to call it"), fileName: str("file name with extension, e.g. Kickoff-Plan.md"), content: str("the whole document"), projectId: str("file it into this project's Drive folder — optional"), folderPath: str("or file it at this path under Eb-02-ODM — optional; folders are created if missing") }, ["content"]),
  tool("list_folder", "See what is actually inside a Drive folder — its sub-folders and its files. Use this for \"what is in X\", \"list the files in X\", or whenever you need to know what exists before deciding anything. Leave folderPath empty for the top of Eb-02-ODM. This is browsing, not searching: it shows you everything at that level.",
    { folderPath: str("the folder to open, e.g. 'Eb-02-ODM', 'Eb-02-ODM/Eb-ODM Execution', or 'Project Management/Eb-09-ML-432-01-1752'. Empty means the top of Eb-02-ODM.") }),
  tool("write_drive_file", "Write a file anywhere in the company Drive. Give a projectId for a project folder, or a folderPath to put it somewhere else entirely — any folder under Eb-02-ODM. Folders in the path that do not exist are created.",
    { projectId: str("a project's folder"), folderPath: str("where to put it instead, e.g. 'Eb-02-ODM/Templates' or 'Eb-ODM Execution/Engineering Services/Shared'"), fileName: str("file name including extension"), content: str("the full text of the file") }, ["fileName", "content"]),
  tool("save_attachment", "File something the user attached into a project's Drive folder, exactly as they sent it.",
    { name: str("the attached file's name"), projectId: str("which project's folder") }, ["name", "projectId"]),
  tool("list_projects", "The full project list with status, deadline, client, team and linked board ids. Cheap — call it whenever you need to be sure.", {}),
  tool("create_project", "Create a project.",
    { projectId: str("e.g. EB-26-014"), name: str("project name"), clientName: str("client"), deadline: str("YYYY-MM-DD"), status: str("Planning | In Progress | On Hold | Done"), linkedIds: strs("linked board folder ids"), knownStatus: str("a paragraph on where it stands"), team: { type: "array", description: "who is on it", items: { type: "object", properties: { name: str("person"), slot: str("their role on this project") } } } }),
  tool("update_project", "Change a project's status, deadline, name, linked ids or written status.",
    { projectId: str("which project"), status: str(""), deadline: str("YYYY-MM-DD"), name: str(""), knownStatus: str(""), linkedIds: strs("") }, ["projectId"]),
  tool("delete_projects", "Delete projects. Pass the whole set in ONE call — a list of ids, or all:true with except:[...]. The user is asked to confirm once, so never call this repeatedly for the same request.",
    { projectIds: strs("the projects to delete"), all: { type: "boolean", description: "delete every project" }, except: strs("ids to keep when all is true") }),
  tool("add_task", "Raise a task for somebody.",
    { title: str("what has to be done"), assignee: str("who"), projectId: str("which project"), date: str("YYYY-MM-DD"), startTime: str("HH:MM"), endTime: str("HH:MM") }, ["title"]),
  tool("update_task", "Change an existing task — its status or who owns it.",
    { match: str("enough of the task's title to find it"), status: str("pending | in-progress | blocked | done"), assignee: str("move it to this person") }, ["match"]),
  tool("assign_resource", "Put somebody on a project.", { name: str("person"), projectId: str("project"), slot: str("their role on it") }, ["name", "projectId"]),
  tool("unassign_resource", "Take somebody off a project.", { name: str("person"), projectId: str("project") }, ["name", "projectId"]),
  tool("add_resource", "Add a new person to the team roster.",
    { name: str("full name"), email: str("work email — this is how they get their login"), title: str("job title"), dept: str("department"), resourceRole: str("jr_pm|sr_pm|jr_fw|sr_fw|jr_hw|sr_hw|sc|ind_design|sol_arch"), role: str("superadmin|dept_head|pm|engineer"), skills: strs(""), maxProjects: { type: "number", description: "how many projects at once" } }, ["name"]),
  tool("add_scrum_note", "Write a note into the daily scrum, in the user's own words.", { text: str("the note"), date: str("YYYY-MM-DD") }, ["text"]),
  tool("add_memory", "Remember something for good — a rule, a preference, a standing instruction. It is injected into every future AI answer.",
    { title: str("short label"), content: str("the full text"), type: str("instruction|template|conversation") }, ["content"]),
  /* The rules this assistant works to are data, not code — so it can read them,
     add to them and take them away when the person tells it to. */
  tool("list_memory", "Read the standing rules and notes in System Memory — everything that shapes how you and every other AI answer here.", {}),
  tool("update_memory", "Change a standing rule. Find it by its title or by a phrase from it.",
    { match: str("enough of the existing rule's title or text to find it"), title: str("the new title — optional"), content: str("the new text of the rule") }, ["match", "content"]),
  tool("delete_memory", "Remove a standing rule that no longer applies.", { match: str("enough of its title or text to find it") }, ["match"]),
  tool("assign_training", "Assign training to somebody.", { name: str("person"), title: str("what to learn"), resource: str("link or book"), due: str("YYYY-MM-DD") }, ["name", "title"]),
];

/* One round trip. Returns the raw Anthropic message. */
async function agentTurn({ messages, system, tools, maxTokens }) {
  const attempts = [];
  if (import.meta.env.VITE_CLAUDE_PROXY_URL) attempts.push({ url: import.meta.env.VITE_CLAUDE_PROXY_URL, direct: false });
  if (import.meta.env.VITE_ANTHROPIC_API_KEY || attempts.length === 0) attempts.push({ url: "https://api.anthropic.com/v1/messages", direct: true });
  let lastErr;
  for (const a of attempts) {
    try {
      const headers = { "Content-Type": "application/json" };
      if (a.direct && import.meta.env.VITE_ANTHROPIC_API_KEY) {
        headers["x-api-key"] = import.meta.env.VITE_ANTHROPIC_API_KEY;
        headers["anthropic-version"] = "2023-06-01";
        headers["anthropic-dangerous-direct-browser-access"] = "true";
        headers["anthropic-beta"] = AGENT_BETA;
      }
      const res = await fetch(a.url, {
        method: "POST", headers,
        body: JSON.stringify({ model: AI_MODEL, max_tokens: maxTokens || 8000, system, tools, messages, anthropic_beta: AGENT_BETA }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error?.message || data.message || `${res.status} ${res.statusText}`);
      if (data.error) throw new Error(data.error.message || "API error");
      if (!Array.isArray(data.content)) throw new Error(data.message || "unexpected AI response");
      return data;
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error("AI unreachable");
}

/* Run until the model stops asking for tools. `exec` runs one workspace tool
   and returns whatever the model should see next; `onStep` reports progress so
   the person is not staring at a spinner. */
async function runAgent({ messages, system, exec, onStep, onText, maxSteps = MAX_STEPS }) {
  const convo = [...messages];
  const tools = [...WORKSPACE_TOOLS, ...SERVER_TOOLS];
  let steps = 0;
  for (;;) {
    const msg = await agentTurn({ messages: convo, system, tools });
    const text = (msg.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
    const calls = (msg.content || []).filter((b) => b.type === "tool_use" && WORKSPACE_TOOLS.some((t) => t.name === b.name));
    if (text) onText?.(text, calls.length > 0);
    convo.push({ role: "assistant", content: msg.content });

    if (msg.stop_reason !== "tool_use" || !calls.length) return { convo, text };
    if (++steps >= maxSteps) {
      convo.push({ role: "user", content: calls.map((c) => ({ type: "tool_result", tool_use_id: c.id, content: "Stopped here — this has taken too many steps. Tell the user what you did and what is left." })) });
      const last = await agentTurn({ messages: convo, system, tools: SERVER_TOOLS });
      const t = (last.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
      if (t) onText?.(t, false);
      return { convo, text: t };
    }

    const results = [];
    for (const c of calls) {
      onStep?.(c.name, c.input);
      let out;
      try { out = await exec(c.name, c.input || {}); }
      catch (e) { out = `That failed: ${String(e?.message || e).slice(0, 300)}`; }
      results.push({ type: "tool_result", tool_use_id: c.id, content: String(out ?? "done").slice(0, 24000) });
    }
    convo.push({ role: "user", content: results });
  }
}

/* Anthropic runs this one itself/* Anthropic runs this one itself — it searches, reads the results and folds
   them into the answer, all inside the single call. No search key of our own,
   and the citations come back in the same content array. */
const WEB_TOOL = { type: "web_search_20250305", name: "web_search", max_uses: 5 };

async function claude(prompt, { json = true, maxTokens = 1000, images = [], web = false } = {}) {
  const attempts = [];
  if (import.meta.env.VITE_CLAUDE_PROXY_URL) attempts.push({ url: import.meta.env.VITE_CLAUDE_PROXY_URL, direct: false });
  if (import.meta.env.VITE_ANTHROPIC_API_KEY || attempts.length === 0) attempts.push({ url: "https://api.anthropic.com/v1/messages", direct: true });
  let lastErr;
  const budget = web ? Math.max(maxTokens, 4000) : maxTokens;
  for (const a of attempts) {
    try {
      const headers = { "Content-Type": "application/json" };
      if (a.direct && import.meta.env.VITE_ANTHROPIC_API_KEY) {
        headers["x-api-key"] = import.meta.env.VITE_ANTHROPIC_API_KEY;
        headers["anthropic-version"] = "2023-06-01";
        headers["anthropic-dangerous-direct-browser-access"] = "true";
      }
      const res = await fetch(a.url, {
        method: "POST", headers,
        body: JSON.stringify({
          model: AI_MODEL, max_tokens: budget,
          messages: [{
            role: "user",
            // the picture first, then the question about it — the order the
            // model reads best
            content: images.length ? [...images, { type: "text", text: prompt }] : prompt,
          }],
          ...(web ? { tools: [WEB_TOOL] } : {}),
        }),
      });
      const data = await res.json().catch(() => ({}));
      // Any non-2xx, or a body that isn't a real Anthropic response, is a
      // failure — never let it through as empty text, or callers silently
      // save blank results instead of falling back.
      if (!res.ok) throw new Error(data.error?.message || data.message || `${res.status} ${res.statusText}`);
      if (data.error) throw new Error(data.error.message || "API error");
      if (!Array.isArray(data.content)) throw new Error(data.message || "unexpected AI response");
      const text = data.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
      if (!text) throw new Error("empty AI response");
      if (!json) return text;
      const clean = text.replace(/```json|```/gi, "").trim();
      const s = clean.indexOf("{"), e = clean.lastIndexOf("}");
      return JSON.parse(s >= 0 ? clean.slice(s, e + 1) : clean);
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error("AI unreachable");
}
/* The whole rulebook goes into every AI call. The old ceiling of 5,200
   characters — about 1,300 tokens — was a guess from when these prompts were
   one-shot and tiny; against a 200k-token window it was throwing away rules
   for no reason. 120,000 characters is roughly 30k tokens, which leaves the
   Drive digest, the attachments and the conversation plenty of room.

   If a workspace ever does write more than that, whole entries are dropped
   from the end and the model is told how many and which — a rule cut off
   mid-sentence is worse than a rule left out and named. */
const MEM_BUDGET = 120000;
const memCtx = (memory) => {
  if (!memory || !memory.length) return "";
  let out = "── SYSTEM MEMORY (org templates, instructions, Drive sitemaps — follow strictly) ──\n";
  const left = [];
  for (const m of memory) {
    const entry = `[${(m.type || "note").toUpperCase()}] ${m.title}\n${m.content}\n\n`;
    if (out.length + entry.length > MEM_BUDGET) { left.push(m.title); continue; }
    out += entry;
  }
  if (left.length) {
    out += `(${left.length} more rule(s) did not fit this message and are NOT shown: ${left.join("; ").slice(0, 500)}. `
      + `Say so if the answer might depend on them, and use list_memory to read one.)\n`;
  }
  return out;
};
const memSize = (memory) => memCtx(memory).length;
const scrumPrompt = (raw, date, users, projects, memory) => `You are the Elecbits ODM daily-scrum organiser.
${memCtx(memory)}
TEAM ROSTER: ${users.map((u) => `${u.name} (${u.title})`).join(", ")}
ACTIVE PROJECTS: ${projects.map((p) => `${p.projectId} — ${p.name} [${p.status}]`).join("; ") || "none"}
DATE: ${date}
Raw scrum note:
"""${raw}"""
Extract every actionable task. Rules: match people to the roster (first names ok); match project IDs to active projects when close (e.g. esp-32-123 ≈ ESP32-123); convert times to 24h HH:MM; capture every if/else contingency as a condition with a timebox in minutes when stated ("in an hour" = 60); keep steps short and imperative.
Respond ONLY with valid JSON, no markdown, exactly this shape:
{"summary":"one line","tasks":[{"projectId":"","title":"","assignee":"","startTime":"","endTime":"","steps":[""],"conditions":[{"if":"","then":"","timeboxMinutes":60}]}]}`;
const questionsPrompt = (t, work, memory) => `You are a strict QA gate for Elecbits ODM task closure.
${memCtx(memory)}
TASK: "${t.title}" on project ${t.projectId || "(unlinked)"} | steps: ${(t.steps || []).join("; ") || "—"} | window ${t.startTime || "?"}–${t.endTime || "?"} | contingencies: ${(t.conditions || []).map((c) => `if ${c.if} then ${c.then}`).join("; ") || "none"}
WORK LOG → done: "${work.whatDone || ""}" | file: "${work.fileName || ""}" | stored at: "${work.fileLocation || ""}"
Ask exactly 3 short, pointed verification questions that expose whether this was truly completed to quality — reference the specific deliverable, file name, storage path and how it was verified. Respond ONLY with JSON: {"questions":["","",""]}`;
const verdictPrompt = (t, work, qa, memory) => `You are the closure verifier for Elecbits ODM tasks. Be strict but fair.
${memCtx(memory)}
TASK: "${t.title}" on ${t.projectId || "(unlinked)"} | steps: ${(t.steps || []).join("; ") || "—"}
WORK LOG → done: "${work.whatDone || ""}" | file: "${work.fileName || ""}" | stored at: "${work.fileLocation || ""}"
VERIFICATION Q&A:
${qa.map((x, i) => `Q${i + 1}: ${x.q}\nA${i + 1}: ${x.a || "(no answer)"}`).join("\n")}
Rules: FAIL if a deliverable task has no concrete file name or storage path, if the path ignores the Drive sitemap conventions, or if answers are vague/unverified. If FAIL, propose 1–3 concrete sub-tasks that would finish the job.
Respond ONLY with JSON: {"verdict":"pass" or "fail","score":0-10,"feedback":"max 2 sentences","subtasks":[{"title":"","timeboxMinutes":60}]}`;
const branchPrompt = (t, blocker, memory) => `An Elecbits ODM task is stuck and must be branched into sub-tasks.
${memCtx(memory)}
TASK: "${t.title}" on ${t.projectId || "(unlinked)"} | steps: ${(t.steps || []).join("; ") || "—"}
BLOCKER / SITUATION: "${blocker || "not fully finished"}"
Propose 2–3 concrete sub-tasks (imperative titles, realistic timeboxes) that unblock and finish this. Respond ONLY with JSON: {"subtasks":[{"title":"","timeboxMinutes":60}]}`;
const alignPrompt = (entry, memory) => `Score today's work-update entry against the Elecbits PM KPIs.
${memCtx(memory)}
KPI DEFINITIONS: ${KPI_DEFS}
ENTRY (free-form daily work-update note):
"""${String(entry.note || "").slice(0, 3000)}"""
Respond ONLY with JSON: {"score":0-100,"feedback":"max 2 sentences, direct","kpiHits":["which KPIs this reflection actually serves"]}`;
const designerPrompt = (cLLD, pname, memory) => `You are Elecbits' senior solution architect. Translate this customer LLD into a concise DESIGNER LLD for project "${pname}".
${memCtx(memory)}
CUSTOMER LLD:
"""${cLLD.slice(0, 3500)}"""
Write plain text (no markdown symbols) under 450 words with these labelled sections: SYSTEM ARCHITECTURE, HARDWARE BLOCKS, FIRMWARE MODULES, INTERFACES & CONNECTIVITY, POWER TREE, TEST HOOKS, RISKS & OPEN POINTS. Be specific (suggest part classes, not vague phrases).`;
const fallbackDesigner = (cLLD, pname) => `DESIGNER LLD — ${pname} (offline template; refine with AI later)

SYSTEM ARCHITECTURE
Single main controller board derived from the customer LLD below; modular sensor/actuator daughter connections where volume allows.

HARDWARE BLOCKS
MCU/SoC per processing needs; power management IC; sensor front-ends; protection (TVS, fusing) on every external connector.

FIRMWARE MODULES
Bootloader (OTA-ready if required), HAL/driver layer, application logic, diagnostics + logging.

INTERFACES & CONNECTIVITY
As per customer LLD radio/wired selections; antenna keep-out and cert pre-scan planned at layout stage.

POWER TREE
Source per customer LLD; buck/LDO rails sized with 30% headroom; sleep-mode budget if battery.

TEST HOOKS
UART pads, test points on every rail, current-sense jumper, tag-connect for programming.

RISKS & OPEN POINTS
Derived from: ${cLLD.slice(0, 400)}…`;
const fallbackScrum = (raw, date, users, projects) => {
  const sentences = raw.split(/(?<=[.;\n])\s+/).map((s) => s.trim()).filter(Boolean);
  const pidM = raw.match(/project\s*id\s*[-:—]*\s*([\w-]+)/i);
  let pid = pidM ? pidM[1] : "";
  const match = projects.find((p) => normId(p.projectId) === normId(pid));
  if (match) pid = match.projectId;
  const tasks = [];
  for (const s of sentences) {
    const person = users.find((u) => new RegExp(`\\b${u.name.split(" ")[0]}\\b`, "i").test(s));
    if (!person) continue;
    const times = [...s.matchAll(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)/gi)].map((m) => { let h = +m[1] % 12; if (m[3].toLowerCase() === "pm") h += 12; return String(h).padStart(2, "0") + ":" + (m[2] || "00"); });
    tasks.push({ projectId: pid, title: s.slice(0, 90), assignee: person.name, startTime: times[0] || "", endTime: times[1] || "", steps: [s.slice(0, 140)], conditions: /\bif\b/i.test(s) ? [{ if: s.split(/\bif\b/i)[1]?.slice(0, 80) || "condition in note", then: "follow the contingency written in the note", timeboxMinutes: 60 }] : [] });
  }
  if (!tasks.length) tasks.push({ projectId: pid, title: raw.slice(0, 90), assignee: "", startTime: "", endTime: "", steps: [raw.slice(0, 160)], conditions: [] });
  return { summary: "Offline basic parse — AI was unreachable, review before pushing.", tasks };
};
/* Drive intelligence — read the PM + PCB folders and say what's going on. */
/* Told to every AI that touches Drive, so none of them invent an address or a
   filename. The tree is fixed; what sits inside a project folder is not. */
const DRIVE_FACTS = `WHERE THE FILES ARE
Project folders live at one address and nowhere else:
  ${PM_ROOT}/<Project ID>/      — the project management side
  ${PCB_ROOT}/<board folder>/   — the hardware and firmware side
YOU ALSO HAVE THE INTERNET. A web_search tool is attached to every one of your replies — use it yourself, without asking, whenever the answer depends on something outside this workspace: a part number, a datasheet figure, a supplier's lead time, a certification rule, a standard, a price, anything current. Search first and answer from what you find, with the source named. Two rules: the Drive files and the workspace data below are the authority on THIS company's projects — never let a search result override them — and never say you cannot look something up.

Names INSIDE a project folder are not standard. There is no guaranteed checklist, no guaranteed Reports folder — people name things however they like, and it changes from project to project. So never expect a particular file name, never say something is missing because it is not called what you expected, and never tell anyone what a folder "should" contain. Look at what is actually there, including the sub-folders, read whatever is relevant, and answer from that.`;

const driveIntelPrompt = (p, users, memory, driveData) => `You are the Elecbits ODM project-intelligence analyst. Read the project's Google Drive knowledge and report what is actually going on and how things are moving.
${memCtx(memory)}
PROJECT: ${p.projectId} — ${p.name || "(unnamed)"} | status ${p.status} | deadline ${p.deadline || "?"}
${DRIVE_FACTS}
PROJECT FOLDER: ${pmPath(p.projectId)}
LINKED BOARD FOLDERS: ${(p.linkedIds || []).map((x) => `${pcbPath(x)}`).join(", ") || "none linked"}
${driveData ? `WHAT IS ACTUALLY IN THOSE FOLDERS RIGHT NOW — the full listing plus the text inside the files:\n"""${driveData}"""` : "The Drive read came back empty this time — reason from the known status and the intelligence log below."}
TEAM: ${(p.team || []).map((t) => `${users.find((u) => u.id === t.userId)?.name || "?"} (${t.slot})`).join(", ") || "none"}
KNOWN STATUS (human-written): """${(p.knownStatus || "not provided").slice(0, 1500)}"""
MANUAL INTELLIGENCE LOG: ${(p.intelligence || []).map((e) => e.text).join(" | ").slice(0, 1500) || "none"}
Write plain text (no markdown symbols), under 220 words, with these labelled lines: WHERE IT STANDS, HOW IT IS MOVING, RISKS / BLOCKERS, NEXT MOVES. Be concrete and reference the folders, files and IDs above.`;
const fallbackIntel = (p) => `WHERE IT STANDS\n${p.projectId} — ${p.name || ""}, status ${p.status}, deadline ${p.deadline || "?"}. ${p.knownStatus ? "Known status: " + p.knownStatus.slice(0, 300) : "No written status yet."}\n\nHOW IT IS MOVING\nDrive read unavailable (AI offline). Reference: ${pmPath(p.projectId)} and PCB folders ${(p.linkedIds || []).join(", ") || "—"}.\n\nRISKS / BLOCKERS\nAdd manual intelligence below so the OS can reason about this project.\n\nNEXT MOVES\nOrganise a scrum note to create the first tasks, then re-run the analysis.`;
/* Organise a manual-intelligence note into a crisp status line. */
const intelOrgPrompt = (p, raw, memory) => `Organise this manual intelligence note about Elecbits ODM project ${p.projectId} into one or two crisp status sentences (plain text, no markdown). Keep facts, drop filler.
${memCtx(memory)}
NOTE: """${String(raw).slice(0, 1200)}"""`;
/* Workspace assistant — the chat that follows you across every page. */
const workspacePrompt = (ctx, history, q, memory, atts, fresh = true) => `You are the Elecbits ODM assistant. You help everyone here — project managers, engineers, department heads — with anything about their work.
${CHAT_STYLE}
Everything below is what you can see across the whole workspace. Use it to answer. If the answer needs a specific project's Drive files, say which project to open and offer what you do know.
${atts?.length ? `They can hand you files right here — including on an earlier message. To keep one, end your reply with a line of exactly this shape, one line per file:
<<<SAVETO project id | the file's name>>>
The file goes into that project's folder in Drive exactly as they sent it. Always write the file's name after the bar, even when only one file is in hand — never file two documents with a single line. Never say you cannot take or store a file.` : ""}
${attachCtx(atts, fresh)}
WHO IS ASKING: ${ctx.meName} (${ctx.meTitle})
TODAY: ${todayStr()}
PROJECTS (${ctx.projects.length}): ${ctx.projects.map((p) => `${p.projectId} "${p.name}" · ${p.status} · due ${p.deadline || "?"} · PM ${p.pmName || "unassigned"} · ${p.done}/${p.total} tasks done${p.knownStatus ? ` · status: ${p.knownStatus.slice(0, 120)}` : ""}`).join("\n") || "none yet"}
OPEN TASKS (${ctx.openTasks.length}): ${ctx.openTasks.slice(0, 30).map((t) => `${t.title} — ${t.who} · ${t.projectId || "no project"} · ${t.status}${t.when ? ` · ${t.when}` : ""}`).join("\n") || "none"}
TEAM (${ctx.team.length}): ${ctx.team.map((u) => `${u.name} (${u.title})${u.load ? ` — ${u.load} open` : ""}`).join(", ")}
RECENT SCRUM NOTES: ${ctx.notes.slice(0, 5).map((n) => `${n.date}: ${String(n.raw).slice(0, 160)}`).join(" | ") || "none"}
${memCtx(memory)}
RECENT CHAT: ${history.slice(-6).map((m) => `${m.who === "me" ? "User" : "You"}: ${m.text}`).join(" | ") || "—"}
QUESTION: """${String(q).slice(0, 600)}"""`;

/* ── COMMAND CENTRE ────────────────────────────────────────────────────────
   The full assistant on the main menu. Same knowledge as the workspace chat,
   but it can actually DO things: create projects, put people on them, raise
   tasks, write today's scrum, add memory, assign training, and read or write
   the project's Google Drive. It performs actions by emitting DO blocks that
   the app executes — see runAction() in AssistantModule.                      */
const ASSISTANT_ACTIONS = `WHAT YOU CAN DO (you are not just an adviser — you operate this system)
To do something, end your reply with one or more blocks in exactly this shape, and nothing after the last one:
<<<DO>>>
{"action":"...", ...}
<<<END>>>
One block per thing. Always write one short plain line BEFORE the blocks saying what you are doing. Never show the blocks themselves in your sentence, never explain the format, never ask the user to run anything.

DO THE WHOLE JOB IN ONE TURN. When they ask for something across many things — "delete all the projects except 1752", "close every overdue task on EB-24-001", "put Ravi on all three boards" — do not do one and stop, and do not hand it back a step at a time. Either use the bulk form of the action where there is one, or emit every block the job needs in this one reply. Working through a list one item per message is the wrong answer; they asked once, so it happens once.

The actions, with their fields:
{"action":"create_project","projectId":"EB-24-001","name":"Smart Meter","clientName":"Acme","deadline":"2026-09-30","status":"Planning","linkedIds":["EB-24-001-PCB-R1"],"knownStatus":"one paragraph of where it stands","team":[{"name":"Saurav","slot":"PM (Project Manager)"},{"name":"Ravi","slot":"Jr. Hardware Engineer"}]}
{"action":"update_project","projectId":"EB-24-001","status":"In Progress","deadline":"2026-10-15","knownStatus":"...","name":"...","linkedIds":["..."]}
{"action":"delete_project","projectId":"EB-24-001"}
{"action":"delete_projects","projectIds":["EB-24-001","EB-24-002"]}          — several at once
{"action":"delete_projects","all":true,"except":["EB-09-ML-432-01-1752"]}    — everything but the ones named
{"action":"assign_resource","name":"Ravi","projectId":"EB-24-001","slot":"Jr. Hardware Engineer"}
{"action":"unassign_resource","name":"Ravi","projectId":"EB-24-001"}
{"action":"add_resource","name":"Asha Menon","title":"Jr. Firmware Engineer","dept":"Firmware","resourceRole":"jr_fw","role":"engineer","skills":["Embedded C"],"maxProjects":3,"email":"asha@elecbits.in"}
{"action":"add_task","title":"Run DRC on rev B gerbers","assignee":"Ravi","projectId":"EB-24-001","date":"2026-08-06","startTime":"10:00","endTime":"12:00"}
{"action":"update_task","match":"DRC on rev B","status":"done","assignee":"Neha"}
{"action":"add_scrum_note","text":"the full note in the user's own words","date":"2026-08-05"}
{"action":"add_memory","title":"Gerber review rule","content":"the full text to remember","type":"instruction"}
{"action":"assign_training","name":"Ravi","title":"Altium constraint manager","resource":"link or book","due":"2026-08-20"}
{"action":"read_drive","projectId":"EB-24-001","search":"thermal test"}   (search tells the reader what to hunt for inside the folder; leave projectId out entirely and it searches every project folder in the company for that term instead)
{"action":"write_drive_file","projectId":"EB-24-001","fileName":"Milestones.md","content":"the complete file content"}
{"action":"save_attachment","name":"Datasheet.pdf","projectId":"EB-24-001"}   (puts a file they attached into that project's Drive folder)
{"action":"create_doc","title":"Kickoff plan","fileName":"Kickoff-Plan.md","content":"the complete document","projectId":"EB-24-001"}   (writes a real document and shows it in the chat as an openable, downloadable card; projectId is optional — include it to also file the doc in that project's Drive folder)
{"action":"open_page","page":"scrum"}    (pages: projects, scrum, tasks, resources, perf, memory)

HOW TO DECIDE
- If the person is telling you something that belongs in the daily scrum ("today Ravi will…", a stand-up dump, anything about who is doing what today) — put it in with add_scrum_note. Do not just reply about it.
- If they ask you to remember something, add_memory.
- If they name work for someone, add_task with that person.
- If they describe a project that is not in the list, create_project. Use whatever they gave you and sensible defaults for the rest; never refuse for a missing field, and never interrogate them with a list of questions. Ask at most one short question, and only if you truly cannot proceed.
- If they want to know what is inside a project's files, read_drive for that project first, putting what they are after in "search". The whole folder tree comes back with the text inside the files, and you answer in the same conversation. Read it yourself — never ask them which file to open, and never ask them to send you a file that is already in the folder.
- If the first look does not have what they need, read_drive again with a different search term before saying you could not find it.
- When they ask about something across the whole company rather than one project ("find the checklists everywhere", "which projects have a BoM"), use read_drive with just a search term and no projectId. Do that instead of asking them which project they mean.
- When they ask you to draft, write, prepare or make any document — a plan, checklist, report, minutes, summary, spec — use create_doc with the real, complete content. The document appears right in the chat, where they can open it and download it. Include projectId when it belongs to a project so it is also filed in Drive. Use .md for documents and .csv for tables.
- write_drive_file is for when a file only needs to exist in Drive; create_doc is better whenever a person is waiting to see the document.
- When they attach a file: if you can see its contents, use them straight away — summarise it, answer from it, turn it into tasks, remember it, whatever they asked. If they want it kept, save_attachment into the right project. If it is obvious which project it belongs to, just do it; otherwise ask one short question naming the likely projects.
- You can accept files. Never say you cannot take an upload or cannot add interface features.
- Statuses are one of: Planning, In Progress, On Hold, Delayed, Completed. Team slots: ${TEAM_SLOTS.join(", ")}.
- Dates are YYYY-MM-DD. Times are HH:MM, 24-hour.
- Use people's names as they appear in the team list; near-enough spelling is fine, the system matches them.
- Do several things in one go when that is what was asked — several blocks, one after another.
- If the request is only a question, answer it and emit no blocks at all.`;

/* The system prompt for the agent. No action protocol in it — the tools are
   real tools now, described by their own schemas, so the model is told what it
   IS rather than how to format a request. */
const agentSystem = (ctx, memory) => `You are the Elecbits ODM assistant. You run this company's hardware project management system, and the people here ask you first.

${CHAT_STYLE}

HOW YOU WORK
You have real tools. Use them without asking permission and without narrating the mechanics — nobody wants to hear "I will now call read_drive". Do the work, then say what you found or what you changed, in plain words.

Finish the job in one go. If an answer needs three lookups and two changes, do all five. Chain them: read the tracker, then create what it lists; search the web for a lead time, then move the plan. Never hand back a half-done job with "shall I continue?", and never work a list one item per message — if they ask for something across many things, use the bulk form of the tool or call it once with everything in it.

Check before you claim. If you are asked what exists, look — do not answer from memory of the conversation. list_projects and read_drive are cheap.

WHAT YOU CAN REACH
· This workspace — projects, tasks, the team roster, the daily scrum, system memory, training.
· The company's Google Drive, all of it under Eb-02-ODM — not only ${DRIVE_CHAIN}. list_folder opens any folder and shows what is in it, read_drive searches and reads the files. If you are asked what is somewhere, OPEN IT with list_folder rather than saying you cannot see it. File names in there are not standard: never expect a particular name, never say something is missing because it is not called what you expected. Look at what is actually there.
· The internet, through web_search. Use it for anything current or external — a part number, a datasheet figure, a supplier lead time, a standard, a price — and name the source. Drive and this workspace remain the authority on this company's own projects; a search result never overrides them.
· Code execution, for anything you cannot do reliably in your head: arithmetic over a list, parsing a table, working out dates and durations, checking a BoM adds up.
· Anything the person attaches — screenshots, PDFs, spreadsheets. You can see images and read documents directly. Never say you cannot see or read something they have given you.

NEVER INVENT A LIMIT
If you are not sure whether you can do something, TRY IT. The tool will tell you, and its answer is the truth. Do not reason from what you imagine the system allows, do not describe permissions or policies you have not been told about, and never say something is "locked down" or "how the system was built" — you do not know that. "I tried and it refused, here is what it said" is always better than a guess about the rules.

You can write anywhere in the company Drive, not only into project folders: give write_drive_file or create_doc a folderPath and missing folders are created on the way.

THE RULES ARE YOURS TO CHANGE
System Memory below is the standing rulebook for this workspace — how things are named, what must happen before a review, anything this team has decided. It is data, not code. When somebody tells you a way of working has changed, change it: add_memory for a new rule, update_memory to reword one, delete_memory when it no longer applies. Read them back with list_memory. Never tell anyone a rule can only be changed by an admin or "on the backend" — you are how it gets changed. Where a rule here conflicts with your own defaults, the rule wins.

WHEN SOMETHING FAILS
Say so plainly and say what would fix it. Never report a failure as though it worked.

${memCtx(memory)}
WHO IS ASKING: ${ctx.meName} (${ctx.meTitle})${ctx.isAdmin ? " — an admin, so anything goes" : ""}
TODAY: ${todayStr()} ${nowHM()}
THE WORKSPACE RIGHT NOW — a snapshot, not the last word; look things up when it matters:
PROJECTS: ${JSON.stringify(ctx.projects || []).slice(0, 4000)}
OPEN TASKS: ${JSON.stringify(ctx.openTasks || []).slice(0, 3000)}
TEAM: ${JSON.stringify(ctx.team || []).slice(0, 2000)}`;

const assistantPrompt = (ctx, history, q, memory, driveData, atts, fresh = true) => `You are the Elecbits ODM assistant — the person everyone in this company asks first. You know the whole workspace and you run it for them.
${CHAT_STYLE}
${ASSISTANT_ACTIONS}
WHO IS ASKING: ${ctx.meName} (${ctx.meTitle})${ctx.isAdmin ? " — an admin, so anything goes" : ""}
TODAY: ${todayStr()} ${nowHM()}
PROJECTS (${ctx.projects.length}): ${ctx.projects.map((p) => `${p.projectId} "${p.name}" · ${p.status} · due ${p.deadline || "?"} · PM ${p.pmName || "unassigned"} · team ${p.teamNames || "none"} · ${p.done}/${p.total} tasks done${p.knownStatus ? ` · status: ${p.knownStatus.slice(0, 140)}` : ""}`).join("\n") || "none yet"}
OPEN TASKS (${ctx.openTasks.length}): ${ctx.openTasks.slice(0, 40).map((t) => `${t.title} — ${t.who} · ${t.projectId || "no project"} · ${t.status}${t.when ? ` · ${t.when}` : ""}`).join("\n") || "none"}
TEAM (${ctx.team.length}): ${ctx.team.map((u) => `${u.name} — ${u.title}${u.dept ? `, ${u.dept}` : ""} · ${u.load} open task(s)`).join("\n")}
RECENT SCRUM NOTES: ${ctx.notes.slice(0, 5).map((n) => `${n.date}: ${String(n.raw).slice(0, 200)}`).join(" | ") || "none"}
${memCtx(memory)}
${DRIVE_FACTS}
${driveData ? `DRIVE — the full folder tree and the text inside the files, read just now:\n"""${driveData}"""` : ""}
${attachCtx(atts, fresh)}
TODAY'S CONVERSATION SO FAR — this is one shared thread the whole team writes into, so each line says WHO said it. Only answer for the person asking now; never treat someone else's line as theirs.
${history.slice(-10).map((m) => `${m.who === "me" ? (m.byName || "Someone") : "You"}: ${m.text}`).join("\n") || "—"}
WHAT THEY SAID: """${String(q).slice(0, 1500)}"""`;

/* ── PROJECT PLAN ──────────────────────────────────────────────────────────
   One list of stages with dates, owners, status and the real files that prove
   each one — drawn from the project's own Drive folders and its tasks. It is
   what the Gantt, the flow chart and the step list all read from, and every
   edit is stamped with who made it and when.                                 */
const PLAN_STATUS = [
  { k: "done", label: "Done", c: "var(--green)" },
  { k: "active", label: "In progress", c: "var(--blue)" },
  { k: "blocked", label: "Blocked", c: "var(--red)" },
  { k: "pending", label: "Not started", c: "var(--txt3)" },
];
const planColor = (s) => PLAN_STATUS.find((x) => x.k === s)?.c || "var(--txt3)";
const planLabel = (s) => PLAN_STATUS.find((x) => x.k === s)?.label || "Not started";
/* The shape every AI reply must produce, described once. */
const PLAN_SHAPE = `A stage looks like this:
{"id":"kickoff","name":"Kickoff","status":"done","track":"PM","start":"2026-08-01","end":"2026-08-05","owner":"Ravi","note":"one plain line on where this stands","evidence":["the real file name that proves it"]}
status is exactly one of: done, active, blocked, pending. Dates are YYYY-MM-DD. owner is a person's name from the team, or "". evidence lists real file names you actually saw in Drive — never invent one. Give every stage an id in lower-case-with-dashes.
"track" is the workstream the stage belongs to — Hardware, Firmware, Enclosure, Testing, Supply chain, PM, or whatever the project actually uses. Hardware work does not wait for firmware work: put things that genuinely run at the same time on DIFFERENT tracks with OVERLAPPING dates. Only stagger dates where one thing truly cannot start until another finishes. A plan where every stage runs one after another is almost always wrong for a hardware project.`;

const planBuildPrompt = (p, projTasks, users, memory, driveData) => `You are the Elecbits ODM planner. Build the delivery plan for this hardware project from what actually exists — its Drive folders, its files, its tasks and its written status. This is not a template exercise: the stages, the dates and the state of each one must reflect the real evidence in front of you.
${memCtx(memory)}
${DRIVE_FACTS}
PROJECT: ${p.projectId} — ${p.name || ""} | status ${p.status} | started ${p.startDate || (p.createdAt || "").slice(0, 10)} | deadline ${p.deadline || "not set"}
TEAM: ${(p.team || []).map((t) => `${users.find((u) => u.id === t.userId)?.name || "?"} (${t.slot})`).join(", ") || "nobody assigned yet"}
LINKED BOARDS: ${(p.linkedIds || []).join(", ") || "none"}
KNOWN STATUS: """${(p.knownStatus || "—").slice(0, 900)}"""
TASKS (${projTasks.length}): ${projTasks.slice(0, 40).map((t) => `${t.title} · ${users.find((u) => u.id === t.assigneeId)?.name || "unassigned"} · ${t.status}${t.date ? ` · ${t.date}` : ""}`).join("; ") || "none raised yet"}
${driveData ? `THE PROJECT'S DRIVE — folders, files and the text inside them:\n"""${driveData}"""` : "No Drive contents came back this time — build the plan from the tasks and the written status."}

HOW TO BUILD IT
- If a checklist, tracker or audit sheet is in the files, follow ITS stages and ITS wording. That document is the source of truth for what this project's flow actually is — do not impose a generic one over it.
- Mark a stage done only when something in Drive or a finished task shows it is done. Name that file in "evidence".
- The stage being worked on now is "active". Anything waiting on a decision or a supplier is "blocked".
- Spread the dates sensibly between the start and the deadline, keeping any real dates you can see.
- Between 5 and 14 stages. Fewer, meaningful stages beat many trivial ones.
${PLAN_SHAPE}
Reply with JSON only: {"stages":[...],"summary":"one plain sentence on where the project stands overall"}`;

/* Building the plan from a checklist someone uploaded, rather than from Drive.
   Their sheet is the authority — its wording, its order, its parallelism. */
const planFromSheetPrompt = (p, users, sheetName, sheetText) => `You are the Elecbits ODM planner. Someone has uploaded their own checklist for project ${p.projectId} and wants the plan built from it. Their sheet is the authority: use ITS stage names, ITS order, ITS owners and ITS dates wherever they are given. Do not substitute a generic flow, and do not drop rows because they look unfamiliar.
FILE: ${sheetName}
CONTENTS (rows as they appear, sheet by sheet):
"""${String(sheetText).slice(0, 14000)}"""
PROJECT: ${p.projectId} — ${p.name || ""} | starts ${p.startDate || (p.createdAt || "").slice(0, 10)} | deadline ${p.deadline || "not set"}
TEAM: ${(p.team || []).map((t) => `${users.find((u) => u.id === t.userId)?.name || "?"} (${t.slot})`).join(", ") || "nobody assigned yet"}

HOW TO READ THEIR SHEET
- Work out which column is the stage or task name, which is status, which is the owner, and which are dates. Headers vary and may not be on the first row — look at the data.
- A status column might say Done / Complete / Yes / Pending / WIP / Blocked / N-A. Map it: done, active, blocked, pending. Anything empty or unrecognised is pending.
- If the sheet has separate sections or sheets for hardware, firmware, testing and so on, those are the tracks. Otherwise infer the track from the row's wording.
- Where the sheet gives no dates, spread them sensibly between the project start and the deadline — but keep genuinely parallel workstreams overlapping rather than queued.
- Keep every row that is a real piece of work. Drop only headers, blank rows and totals.
${PLAN_SHAPE}
Reply with JSON only: {"stages":[...],"summary":"one plain sentence on what this checklist covers and where it stands"}`;

/* Stages that share a track are one workstream; different tracks run side by
   side. Everything without a track falls into one unnamed group. */
const trackGroups = (stages) => {
  const order = [];
  const byTrack = new Map();
  for (const s of stages) {
    const t = (s.track || "").trim() || "Plan";
    if (!byTrack.has(t)) { byTrack.set(t, []); order.push(t); }
    byTrack.get(t).push(s);
  }
  return order.map((t) => [t, byTrack.get(t)]);
};
const hasTracks = (stages) => new Set(stages.map((s) => (s.track || "").trim() || "Plan")).size > 1;

/* Read an uploaded checklist into plain rows the AI can follow. .xlsx and .xls
   go through SheetJS, which is loaded only when someone actually uploads one;
   .csv and text formats are already rows. */
async function sheetToText(file) {
  const name = (file.name || "").toLowerCase();
  if (/\.(csv|tsv|txt|md)$/.test(name)) return (await file.text()).slice(0, 20000);
  const XLSX = await import("xlsx");
  const wb = XLSX.read(await file.arrayBuffer(), { type: "array" });
  return wb.SheetNames.map((sheet) => {
    const rows = XLSX.utils.sheet_to_csv(wb.Sheets[sheet], { blankrows: false });
    return `--- SHEET: ${sheet} ---\n${rows}`;
  }).join("\n\n").slice(0, 20000);
}

/* An offline skeleton, so the panel is never blank when the AI is unreachable. */
const fallbackPlan = (p) => {
  // Dates typed by hand are not always dates. A bad one used to throw a
  // RangeError out of toISOString and leave the button spinning for ever.
  const day = (v, fallback) => {
    const t = new Date(v).getTime();
    return Number.isFinite(t) ? t : fallback;
  };
  const startMs = day(p.startDate || (p.createdAt || "").slice(0, 10), day(todayStr(), Date.now()));
  const endMs = Math.max(startMs + 86400000, day(p.deadline, startMs + 90 * 86400000));
  const names = ["Kickoff", "Requirements", "Schematic & design review", "PCB development", "Firmware development", "Testing", "Client handoff"];
  const span = Math.max(1, Math.round((endMs - startMs) / 86400000));
  const at = (i) => new Date(startMs + Math.round((span * i) / names.length) * 86400000).toISOString().slice(0, 10);
  return {
    stages: names.map((name, i) => ({
      id: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
      name,
      status: i === 0 ? "active" : "pending",
      track: ["PM", "PM", "Hardware", "Hardware", "Firmware", "Testing", "PM"][i],
      start: at(i),
      end: at(i + 1),
      owner: "", note: i === 0 ? "Starting point — refresh the plan once the AI is reachable." : "", evidence: [],
    })),
    summary: "Outline plan — refresh it to read the real state from Drive.",
  };
};

/* Applying a change the AI worked out from something the PM said.
   Deliberately pure — no ids, no clock — so it can run inside a React state
   updater, which may be invoked more than once for the same change. The
   caller builds the log entry and merges it. */
const planPatchResult = (plan, patch) => {
  const stages = [...(plan?.stages || [])];
  const touched = [];
  for (const ch of patch.changes || []) {
    const i = stages.findIndex((s) => s.id === ch.id || normId(s.name) === normId(ch.id || ch.name));
    if (ch.remove && i >= 0) { touched.push(`removed ${stages[i].name}`); stages.splice(i, 1); continue; }
    if (i < 0) {
      if (!ch.name) continue;
      const s = { id: ch.id || normId(ch.name) || uid(), name: ch.name, status: ch.status || "pending", start: ch.start || todayStr(), end: ch.end || ch.start || todayStr(), owner: ch.owner || "", note: ch.note || "", evidence: ch.evidence || [] };
      const at = Number.isInteger(ch.after) ? ch.after : stages.length;
      stages.splice(at, 0, s);
      touched.push(`added ${s.name}`);
      continue;
    }
    const before = stages[i];
    const next = { ...before };
    for (const k of ["name", "status", "start", "end", "owner", "note"]) if (ch[k] != null && ch[k] !== "") next[k] = ch[k];
    if (Array.isArray(ch.evidence)) next.evidence = ch.evidence;
    const bits = [];
    if (next.status !== before.status) bits.push(`${before.status} → ${next.status}`);
    if (next.start !== before.start || next.end !== before.end) bits.push(`${before.start}–${before.end} → ${next.start}–${next.end}`);
    if (next.owner !== before.owner) bits.push(`owner ${before.owner || "nobody"} → ${next.owner || "nobody"}`);
    stages[i] = next;
    touched.push(`${before.name}: ${bits.join(", ") || "updated"}`);
  }
  return { stages, touched };
};

/* The email is how a sign-up finds the roster entry a PM filled in, so a typo
   in it is not cosmetic — it silently strands the person as a stranger. These
   catch the two ways it goes wrong: a stray shape, and a near-miss of a domain
   everybody else on the roster uses. */
const emailShapeOk = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(e || "").trim());
const domainOf = (e) => String(e || "").split("@")[1]?.toLowerCase() || "";
/* How many single-character edits apart, up to a cap — cheap and enough. */
const editsApart = (a, b, cap = 2) => {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let prev = [...Array(b.length + 1).keys()];
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = row;
  }
  return prev[b.length];
};
const domainTypo = (email, users) => {
  const d = domainOf(email);
  if (!d) return "";
  const known = [...new Set(users.map((u) => domainOf(u.email)).filter(Boolean))];
  if (known.includes(d)) return "";
  const near = known.find((k) => k !== d && editsApart(d, k) <= 2);
  return near || "";
};

/* Why a roster write bounced, in words a PM can act on. The two that actually
   happen are the schema not being migrated yet and RLS refusing the insert. */
const rosterFailure = (err) => {
  const m = String(err?.message || err || "");
  if (/foreign key|auth\.users|profiles_id_fkey/i.test(m))
    return "Saved here only — the database still requires everyone to have a login first. Run supabase/fix-resource-creation.sql and add them again.";
  if (/invalid input syntax for type uuid/i.test(m))
    return "Saved here only — the database rejected the id format. Run supabase/fix-resource-creation.sql, then add them again.";
  if (/row-level security|permission denied|violates row-level/i.test(m))
    return "Saved here only — the database would not accept a new person from this account. Run supabase/RUN-THIS-FIX-ALL.sql, or ask an admin to add them.";
  if (/duplicate key|already exists/i.test(m))
    return "Somebody with that email is already on the roster.";
  return `Saved here only — the database refused it: ${m.slice(0, 140)}`;
};

/* ── TO-DOS UNDER STAGES ───────────────────────────────────────────────────
   Every to-do on a project belongs to exactly one stage of that project's
   plan. The link lives on the task as `stageId`, so it survives a stage being
   renamed, re-ordered or re-dated — and so a person can move a to-do to the
   right stage by hand and have it stay there.

   Everything below is only for filling that link in the first time: a keyword
   pass that runs the instant a task is created, and an AI pass that reads the
   whole list at once and does the semantic work the keywords cannot ("Create
   MCMA quote" belongs under Design review, and no word in it says so). */
const STAGE_WORDS = {
  kickoff: ["kickoff", "kick off", "scope", "objective", "charter", "brief", "onboard", "assign owner", "reviewer", "start"],
  requirement: ["requirement", "spec", "study", "research", "market", "define", "scope", "objective", "success criteria", "deliverable format", "target market"],
  design: ["design", "schematic", "quote", "quotation", "costing", "bom", "bill of material", "alternate", "component", "review comment", "layout comment", "stackup", "architecture", "concept", "enclosure design"],
  pcb: ["pcb", "layout", "routing", "gerber", "fab", "fabrication", "assembly", "smt", "stencil", "board", "hardware build", "enclosure"],
  firmware: ["firmware", "code", "driver", "bootloader", "flash", "embedded", "software"],
  procurement: ["procure", "purchase", "order", "vendor", "supplier", "lead time", "sourcing", "quote from", "po ", "inventory", "stock"],
  testing: ["test", "testing", "validate", "validation", "thermal", "emi", "emc", "qa", "bring up", "bringup", "debug", "measurement", "report", "verification"],
  compliance: ["compliance", "certification", "certify", "safety", "regulatory", "ce ", "fcc", "rohs", "audit"],
  client: ["client", "customer", "demo", "presentation", "deck", "sign-off", "signoff", "sign off", "acceptance", "delivery", "deliver", "handover", "handoff", "recording", "session"],
  documentation: ["document", "documentation", "manual", "datasheet", "write up", "writeup", "record", "proof", "timestamp", "filename", "rename", "store", "upload", "folder", "drive path"],
  production: ["production", "mass", "volume", "manufactur", "pilot", "ramp", "dfm"],
  closure: ["closure", "close", "retrospective", "lessons", "invoice", "final", "archive", "wrap"],
};
const stageBuckets = (name) => {
  const n = String(name || "").toLowerCase();
  return Object.keys(STAGE_WORDS).filter((k) => n.includes(k) || (k === "pcb" && /\bboard|layout\b/.test(n)) || (k === "client" && /\bcustomer|demo|handover\b/.test(n)) || (k === "requirement" && /\brequirements?\b/.test(n)));
};
const WEAK = new Set(["the", "and", "for", "with", "from", "into", "this", "that", "task", "project", "update", "complete", "check", "review", "create", "make", "add", "per", "all", "new", "its", "our"]);
const words = (s) => String(s || "").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !WEAK.has(w));

/* How well one to-do fits one stage. Higher is better; 0 means no evidence. */
const stageMatchScore = (stage, task) => {
  const title = `${task.title || ""} ${(task.steps || []).join(" ")}`.toLowerCase();
  const tw = new Set(words(title));
  let score = 0;
  for (const w of words(stage.name)) if (tw.has(w)) score += 4;           // shared words in the stage name
  for (const b of stageBuckets(stage.name)) {                              // the stage's subject area
    for (const kw of STAGE_WORDS[b]) if (title.includes(kw)) score += 2;
  }
  if (stage.owner && task.assigneeName && normId(stage.owner) === normId(task.assigneeName)) score += 1;
  if (stage.start && stage.end && task.date && task.date >= stage.start && task.date <= stage.end) score += 1;
  return score;
};
const guessStageId = (stages, task) => {
  if (!stages?.length) return "";
  let best = null, bestScore = 0;
  for (const s of stages) {
    const sc = stageMatchScore(s, task);
    if (sc > bestScore) { best = s; bestScore = sc; }
  }
  return bestScore >= 4 ? best.id : "";   // below that it is a coin toss, so leave it unfiled
};
/* Fill in the link on any task that has not got one yet. Used everywhere a
   task is born and every time a plan is (re)built. A stageId pointing at a
   stage that no longer exists counts as unfiled — rebuilding a plan renames
   every stage, and a dead link would strand the to-do for ever. */
const withStages = (stages, tasks) => {
  const ids = new Set((stages || []).map((s) => s.id));
  return tasks.map((t) => (t.stageId && ids.has(t.stageId) ? t : { ...t, stageId: guessStageId(stages, t) }));
};
const needsFiling = (stages, tasks) => {
  const ids = new Set((stages || []).map((s) => s.id));
  return tasks.filter((t) => !t.stageId || !ids.has(t.stageId));
};

/* Stage order first, then whatever is still unfiled. Stages with nothing in
   them still appear — an empty stage is information too. */
const groupTasksByStage = (stages, tasks) => {
  const rows = (stages || []).map((s) => [s, tasks.filter((t) => t.stageId === s.id)]);
  const ids = new Set((stages || []).map((s) => s.id));
  const loose = tasks.filter((t) => !t.stageId || !ids.has(t.stageId));
  if (loose.length) rows.push([null, loose]);
  return rows;
};

const groupPrompt = (p, stages, tasks) => `You are filing the open to-dos of hardware project ${p.projectId} (${p.name || ""}) under the stages of its delivery plan. Every to-do belongs under exactly one stage — the stage whose work it is part of.

THE STAGES, in order:
${stages.map((s, i) => `${i + 1}. [${s.id}] ${s.name}${s.track ? ` · ${s.track}` : ""}${s.start ? ` · ${s.start} → ${s.end}` : ""}${s.note ? ` — ${s.note}` : ""}`).join("\n")}

THE TO-DOS:
${tasks.map((t) => `[${t.id}] ${t.title}${t.assigneeName ? ` · ${t.assigneeName}` : ""}${t.date ? ` · ${t.date}` : ""}`).join("\n")}

Think about what the work actually IS, not which words it shares with a stage name. Writing a quote for a customer is design-stage work. Renaming a delivered file and storing proof of delivery belongs with the thing that was delivered. Chasing a supplier belongs with the stage that is waiting on the part. A vague to-do like "update on task completion" belongs with whatever stage is running at its date.

File every single to-do. Do not invent stages and do not invent to-dos.

Reply with JSON only: {"filed":[{"task":"<task id>","stage":"<stage id>"}]}`;

/* ── INTERNAL MoM ──────────────────────────────────────────────────────────
   The room where the thinking happens. Somebody types up a brainstorm — a
   design argument, a supplier problem, a review that went badly — and the AI
   pulls out what was actually decided, what the challenge was and how it was
   beaten, whose idea moved the needle, and what has to happen next. The
   lessons go into System Memory so the next project inherits them, the
   actions become real tasks, and the whole note is filed into the project's
   Internal MoM folder in Drive.                                             */
const MOM_IMPACT = [
  { k: "timeline", label: "Saved time", c: "var(--blue)" },
  { k: "quality", label: "Better quality", c: "var(--green)" },
  { k: "cost", label: "Saved cost", c: "var(--purple)" },
  { k: "risk", label: "Avoided a risk", c: "var(--amber)" },
  { k: "other", label: "Idea", c: "var(--txt2)" },
];
const impactOf = (k) => MOM_IMPACT.find((x) => x.k === k) || MOM_IMPACT[4];
const MOM_STATUS = { solved: ["Overcome", "var(--green)"], open: ["Still open", "var(--red)"], watch: ["Watching", "var(--amber)"] };

const momPrompt = (p, raw, attendees, users, memory) => `You are sitting in on an Elecbits engineering discussion and writing it up. This is not a transcript — it is the record the team will read in a year when the same problem comes round again.
${memCtx(memory)}
PROJECT: ${p.projectId} — ${p.name || ""} | status ${p.status} | deadline ${p.deadline || "?"}
IN THE ROOM: ${attendees || "not listed"}
TEAM (use these names, spelled this way): ${users.map((u) => u.name).join(", ")}
WHAT WAS SAID: """${String(raw).slice(0, 8000)}"""

PULL OUT
- CHALLENGES. Every real problem raised, what was done about it, and whether it is actually beaten. If the discussion did not settle it, say so — a pretend solution is worse than an open one.
- IDEAS, each credited to the person who had it. Only count a genuine contribution: a suggestion that changed the approach, saved time or money, caught a risk, or lifted quality. Rate it 1 to 5 on how much it actually helped, and say in one line why. Do not hand out credit for agreeing with someone or for restating the problem. If nobody contributed anything of substance, return no ideas at all.
- DECISIONS, firmly, with whoever owns each one.
- ACTIONS — the concrete next steps. These become real tasks for real people, so each needs a title someone can act on and a name from the team. Give a due date only if the discussion implied one.
- LESSONS. The reusable rule, written so it makes sense on a different project a year from now. "Check the connector's lead time before freezing the BoM", not "we had a connector problem". Nothing generic — only what this discussion actually taught.

Plain English throughout, no jargon, no markdown symbols.
Reply with JSON only:
{"title":"six words on what this was about","summary":"two or three plain sentences","challenges":[{"problem":"...","solution":"...","status":"solved|open|watch"}],"ideas":[{"by":"Ravi","idea":"...","impact":"timeline|quality|cost|risk|other","value":4,"why":"one line on what it actually saved"}],"decisions":[{"what":"...","owner":"Neha"}],"actions":[{"title":"...","assignee":"Ravi","due":"2026-08-20"}],"lessons":["..."]}`;

/* Who has actually been contributing, across every project. Value is the AI's
   1–5 judgement of how much an idea helped, so ten shrugs never outweigh one
   idea that saved a fortnight. */
const momCredit = (projects) => {
  const by = new Map();
  for (const p of projects) {
    for (const m of p.moms || []) {
      for (const i of m.ai?.ideas || []) {
        const name = String(i.by || "").trim();
        if (!name) continue;
        const cur = by.get(name) || { name, count: 0, score: 0, impacts: {}, latest: "", examples: [] };
        cur.count += 1;
        cur.score += Math.max(1, Math.min(5, Number(i.value) || 1));
        cur.impacts[i.impact || "other"] = (cur.impacts[i.impact || "other"] || 0) + 1;
        if (m.date > cur.latest) cur.latest = m.date;
        if (cur.examples.length < 3) cur.examples.push({ idea: i.idea, why: i.why, projectId: p.projectId, impact: i.impact, value: i.value });
        by.set(name, cur);
      }
    }
  }
  return [...by.values()].sort((a, b) => b.score - a.score || b.count - a.count);
};
const allMoms = (projects) => projects.flatMap((p) => (p.moms || []).map((m) => ({ ...m, projectId: p.projectId, projectName: p.name })))
  .sort((a, b) => `${b.date}${b.time}`.localeCompare(`${a.date}${a.time}`));

/* Learn from Drive — distil the project + GW/PCB folders into a reusable memory note. */
const driveLearnPrompt = (pid, linkedIds, knownStatus, memory, driveData) => `You are the Elecbits ODM knowledge engine. Learn everything inferable about project ${pid} from its Drive folders and write a compact knowledge note the OS will reuse when allocating and verifying tasks on this project.
${memCtx(memory)}
${DRIVE_FACTS}
PROJECT FOLDER: ${pmPath(pid)}
LINKED BOARD FOLDERS: ${(linkedIds || []).map((x) => pcbPath(x)).join("; ") || "none linked"}
${driveData ? `WHAT IS ACTUALLY IN THOSE FOLDERS RIGHT NOW — the full listing plus the text inside the files:\n"""${driveData}"""` : ""}
KNOWN STATUS (human-written): """${(knownStatus || "not provided").slice(0, 1500)}"""
Write plain text (no markdown symbols), under 180 words, with these labelled lines: PROJECT SHAPE, ACTIVE WORKSTREAMS, WHAT IS IN THE FOLDER (the real file and sub-folder names you can see, and what each one is for — describe what is there, do not prescribe what should be there), ALLOCATION HINTS (which role types should get which task kinds on this project and what proof to demand at closure).`;
const fallbackLearn = (pid, linkedIds, knownStatus) => `PROJECT SHAPE\n${pid} tracked at ${pmPath(pid)} (Checklist.xlsx: Gantt, PM Milestones, HW Design/Testing, FW Logic/Testing, Overall Testing).${linkedIds?.length ? ` Hardware IDs: ${linkedIds.join(", ")} under ${PCB_ROOT}/ (gerbers, BoM, schematics, test reports).` : ""}\n\nACTIVE WORKSTREAMS\n${knownStatus ? knownStatus.slice(0, 300) : "No written status yet — capture it in Known Status."}\n\nARTEFACT CONVENTIONS\nReports as YYYY-MM-DD_<topic>.pdf in Reports/; Gerber checks need the DRC report saved alongside; BoM checks need availability + alternates columns filled.\n\nALLOCATION HINTS\nHW tasks → hardware engineers with the PCB folder path as evidence; FW tasks → firmware engineers against FW Logic/Testing tabs; client comms → the PM, logged in Client-Comms/. Every closure must name the exact file + Drive path. (AI offline — template learning; re-run later.)`;
/* Project chat — the PM's copilot on deep project details. */
const CHAT_STYLE = `HOW TO TALK — you are speaking to busy project managers and engineers, not to developers:
- Plain, warm, everyday English. Short sentences. No jargon, no system-speak.
- Never mention paths being "invalid", "non-standard", "case-variant", conventions, templates, schemas, IDs of internals, or how the system fetched anything. Nobody cares how it works.
- Never lecture, never explain your limitations, never give instructions about folder naming.
- NEVER describe what you can or cannot see, read or do. No "What I can see" / "What I cannot see" lists, no "I only have metadata, not the contents", no "I do not have the ability to...", no talk of file contents versus file names. The user does not want a report on your abilities — they want the answer.
- You CAN read what is inside the files, including Word documents, PDFs, spreadsheets and presentations. Their text is given to you below whenever it was available. Use it.
- If something you need genuinely is not in front of you, just do the most useful thing you can with what you have, and if you must, ask one short ordinary question ("Which board are you asking about?"). Never turn it into an explanation of the system.
- Never use the words: metadata, capability, limitation, access, permission, integration, API, fetch, index, schema, structure convention.
- NEVER speculate about why you don't see something. No "they might be empty", no "they might not have loaded yet", no "want me to check again?". If a folder's contents are not in front of you, look again yourself with a search term for what they asked about — that is your job, not theirs.
- Never ask the user to confirm that you should go and look. Just look.
- If you searched and found things, simply say what you found, in normal words: "I looked in the FMS-200 folder and found 12 files. The latest is..."
- If you truly could not find something, say it kindly in one line and offer the closest thing you did find, or ask one simple question. Never blame the user or their naming.
- Answer the question first, in the first sentence. Details after. Under 150 words unless asked for more.
- No markdown symbols, no bullet characters like * or #. Use plain lines.`;

const projChatPrompt = (p, projTasks, users, history, q, memory, driveData, atts, fresh = true) => `You are the project assistant for ${p.name || p.projectId} at Elecbits. Help the person in front of you get their answer fast.
${CHAT_STYLE}
The information below is everything you can see, including this project's Google Drive folders AND the text inside the files there, read for you just now. Treat all of it as your own knowledge — you looked at these documents yourself. Never tell the user to go and fetch or paste files for you.
When you mention a file or folder, use the real name and location shown below, exactly as it appears. Do not comment on whether it matches any expected structure — just use what is there.
Quote and summarise document contents freely when they help answer the question. If a file's text is not shown below, simply answer from everything else you have — do not point out that it is missing.

YOU CAN ALSO WRITE TO DRIVE. You are not read-only. When the user asks you to create, add, write, draft, update or save something into the project folder, actually do it by ending your reply with this block and nothing after it:
<<<WRITE filename.md>>>
the full file content here
<<<END>>>
Rules for writing: use one block per file; pick a clear filename with a sensible extension (.md for notes, checklists, plans, minutes; .csv for tables); write the real, complete content — never a placeholder; a file with the same name is replaced, so reuse the exact existing name when updating one. Before the block, say in one short line what you are ABOUT to save — "Putting together the milestone sheet now." Never write "Done", "Saved" or "It's in the folder": whether it reached Drive is confirmed underneath your reply, and claiming it landed when it did not makes you a liar. Never say you cannot create or modify files. Anything you write this way also appears in the chat as a document card the person can open and download.

YOU CAN LOOK IN DRIVE AGAIN, YOURSELF. The Drive contents below were fetched for this question. If they do not cover what is being asked — a particular checklist, a BoM, a board folder, anything — end your reply with:
<<<LOOK what to look for>>>
The whole project folder and every linked board folder are searched for that, the text inside the matching files comes back, and you answer properly in the same breath. Use it instead of saying you cannot see something, and instead of asking whether you should check. Only ever use it once in a reply.

YOU CAN UPDATE THE PLAN. The project's plan — its stages, dates, owners and status — is below. When something they tell you changes it (a customer's feedback on a review, a vendor slipping, a test failing, work finishing early, a mail they forwarded or attached), work out the knock-on effect and end your reply with:
<<<PLAN>>>
{"reason":"customer asked for a 4-layer stackup after the schematic review","summary":"one plain sentence on where the project stands now","changes":[{"id":"design-review","status":"blocked","note":"waiting on the stackup decision"},{"id":"pcb-development","start":"2026-09-02","end":"2026-09-20"},{"name":"Rework schematic for 4-layer","status":"active","start":"2026-08-20","end":"2026-08-27","owner":"Ravi","after":2}],"tasks":[{"title":"Rework the schematic for a 4-layer stackup","assignee":"Ravi","date":"2026-08-20","endTime":"18:00","stage":"design-review"}]}
<<<END>>>
Rules for the plan: only include stages that genuinely change; keep every date realistic against the deadline; push the later stages out when an earlier one slips, do not silently leave them overlapping; "after" is where a new stage slots in, counting from 0; "tasks" is optional and raises real work for real people — give each one a "stage" naming the stage id it belongs under, so it files itself in the right place. Always fill in "reason" in the person's own terms — it is written into the change log with their name and the time. Never invent a change nobody asked for.
${atts?.length ? `They can also hand you files right here — including on an earlier message. To keep one in this project's folder, end your reply with a line of exactly this shape, one line per file, naming the file exactly as it is listed below:
<<<SAVE the-file-name.pdf>>>
It is saved exactly as they sent it. Never say you cannot take or store a file.` : ""}
${attachCtx(atts, fresh)}
${memCtx(memory)}
${DRIVE_FACTS}
PROJECT: ${p.projectId} — ${p.name || ""} | status ${p.status} | deadline ${p.deadline || "?"} | client ${p.clientName || "—"}
TEAM: ${(p.team || []).map((t) => `${users.find((u) => u.id === t.userId)?.name || "?"} (${t.slot})`).join(", ") || "none"}
LINKED IDS: ${(p.linkedIds || []).join(", ") || "none"} | project folder ${pmPath(p.projectId)}
KNOWN STATUS: """${(p.knownStatus || "—").slice(0, 800)}"""
INTELLIGENCE LOG: ${(p.intelligence || []).map((e) => e.text).join(" | ").slice(0, 800) || "—"}
${driveData ? `THE PROJECT'S DRIVE — the whole folder tree and the text inside the files, read just now:\n"""${driveData}"""` : "No Drive files came back this time. Answer from the project notes above without mentioning Drive at all."}
LAST SAVED DRIVE ANALYSIS: """${(p.driveAnalysis?.text || "—").slice(0, 800)}"""
THE PLAN RIGHT NOW: ${(p.plan?.stages || []).length
  ? (p.plan.stages || []).map((s, i) => `${i}. [${s.id}] ${s.name} · ${s.status} · ${s.start || "?"} → ${s.end || "?"}${s.owner ? ` · ${s.owner}` : ""}${s.note ? ` · ${s.note}` : ""}`).join("\n")
  : "no plan built yet — if they ask about steps or timing, say the plan hasn't been built and that the Build plan button on this page will read Drive and lay it out."}
RECENT PLAN CHANGES: ${(p.plan?.log || []).slice(0, 4).map((l) => `${String(l.at).slice(0, 16).replace("T", " ")} ${l.byName}: ${l.what}`).join(" | ") || "none"}
TASKS (${projTasks.length}), each with the stage it is filed under: ${projTasks.slice(0, 25).map((t) => `${t.title} · ${users.find((u) => u.id === t.assigneeId)?.name || "unassigned"} · ${t.status}${t.endTime ? ` · due ${t.endTime}` : ""} · stage ${t.stageId || "not filed"}`).join("; ") || "none yet"}
RECENT CHAT: ${history.slice(-6).map((m) => `${m.who === "me" ? "PM" : "AI"}: ${m.text}`).join(" | ") || "—"}
QUESTION: """${String(q).slice(0, 600)}"""`;

/* ═══ GLOBAL STYLES + UI ATOMS ═══════════════════════════════════════════ */
const CSS = `
@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&display=swap');
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html,body,#root{height:100%}
.eb-root{min-height:100vh;background:var(--bg);color:var(--txt);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;font-size:14px;-webkit-font-smoothing:antialiased;transition:background .25s,color .25s}
.eb-root input,.eb-root select,.eb-root textarea,.eb-root button{font-family:inherit;font-size:13px;color:var(--txt)}
::-webkit-scrollbar{width:6px;height:6px}::-webkit-scrollbar-track{background:transparent}::-webkit-scrollbar-thumb{background:var(--bdr2);border-radius:3px}
@keyframes fadeUp{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
@keyframes spin{to{transform:rotate(360deg)}}
@keyframes pulseDot{50%{opacity:.25}}
.fade{animation:fadeUp .25s ease both}
.spin{animation:spin 1s linear infinite}
.inp{width:100%;background:var(--s1);border:1px solid var(--bdr);border-radius:8px;padding:9px 12px;outline:none;transition:border-color .15s,box-shadow .15s}
.inp:focus{border-color:var(--acc);box-shadow:0 0 0 3px rgba(37,99,235,.12)}
.card{background:var(--s1);border:1px solid var(--bdr);border-radius:12px}
.navItem{display:flex;align-items:center;gap:11px;padding:10px 14px;border-radius:9px;cursor:pointer;color:var(--txt2);font-weight:500;font-size:13px;border:1px solid transparent;transition:all .15s;user-select:none}
.navItem:hover{background:var(--s2);color:var(--txt)}
.navItem.on{background:var(--soft);color:var(--acc);border-color:var(--bdr);font-weight:600}
.rowHover{transition:background .15s}.rowHover:hover{background:var(--s2)}
.branchRail{position:relative;padding-left:18px}
.branchRail::before{content:"";position:absolute;left:6px;top:4px;bottom:4px;width:2px;background:var(--bdr2);border-radius:2px}
.branchRail>div{position:relative}
.branchRail>div::before{content:"";position:absolute;left:-16px;top:12px;width:12px;height:2px;background:var(--bdr2)}
input[type=checkbox]{accent-color:var(--acc);width:15px;height:15px;cursor:pointer}
input[type=date],input[type=time]{color-scheme:light dark}
@media(max-width:900px){.eb-side{display:none!important}.eb-sideM{display:flex!important}}
`;

const Pill = ({ children, color = "var(--txt2)", bg, style }) => (
  <span style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "3px 10px", borderRadius: 99, fontSize: 11, fontWeight: 600, color, background: bg || "color-mix(in srgb, " + color + " 12%, transparent)", whiteSpace: "nowrap", ...style }}>{children}</span>
);
const Btn = ({ children, onClick, kind = "primary", disabled, style, small, icon: Ic, title }) => (
  <button title={title} onClick={onClick} disabled={disabled} style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6, padding: small ? "6px 12px" : "9px 16px", borderRadius: 8, border: kind === "ghost" ? "1px solid var(--bdr)" : "1px solid transparent", cursor: disabled ? "not-allowed" : "pointer", fontSize: small ? 12 : 13, fontWeight: 600, opacity: disabled ? 0.45 : 1, background: kind === "primary" ? "var(--acc)" : kind === "danger" ? "var(--red)" : kind === "green" ? "var(--green)" : kind === "ghost" ? "transparent" : "var(--s2)", color: ["primary", "danger", "green"].includes(kind) ? "#fff" : "var(--txt)", transition: "all .15s", ...style }}>
    {Ic && <Ic size={small ? 13 : 15} />}{children}
  </button>
);
const AvatarDot = ({ user, size = 26 }) => (
  <span title={user?.name} style={{ width: size, height: size, borderRadius: "50%", background: user?.color || "var(--txt3)", color: "#fff", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: size * 0.38, fontWeight: 700, flexShrink: 0, fontFamily: MONO }}>{initials(user?.name)}</span>
);
const Field = ({ label, children, req, hint }) => (
  <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
    <span style={{ fontSize: 10.5, fontWeight: 700, color: "var(--txt2)", textTransform: "uppercase", letterSpacing: ".06em" }}>
      {label}{req && <span style={{ color: "var(--red)" }}> *</span>}
      {hint && <span style={{ marginLeft: 6, textTransform: "none", letterSpacing: 0, fontWeight: 500, color: "var(--txt3)" }}>{hint}</span>}
    </span>
    {children}
  </div>
);
/* A password field you can look at. Typing a password you cannot see is how
   "wrong password" happens; the eye is a peek, not a setting, so it starts
   hidden every time and never persists. */
/* A password an admin can read out over a call: no 0/O or 1/l/I lookalikes. */
const genPassword = () => {
  const chars = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const buf = new Uint32Array(14);
  crypto.getRandomValues(buf);
  return [...buf].map((n) => chars[n % chars.length]).join("");
};

const PasswordInput = ({ value, onChange, onEnter, placeholder = "••••••••", autoComplete = "current-password", autoFocus }) => {
  const [show, setShow] = useState(false);
  return (
    <div style={{ position: "relative" }}>
      <input className="inp" type={show ? "text" : "password"} value={value} autoFocus={autoFocus}
        autoComplete={autoComplete} placeholder={placeholder} style={{ paddingRight: 42 }}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && onEnter?.()} />
      <button type="button" tabIndex={-1} onClick={() => setShow((x) => !x)}
        title={show ? "Hide password" : "Show password"} aria-label={show ? "Hide password" : "Show password"}
        style={{ position: "absolute", top: "50%", right: 6, transform: "translateY(-50%)", width: 30, height: 30, display: "flex", alignItems: "center", justifyContent: "center", background: "none", border: "none", borderRadius: 7, color: show ? "var(--acc)" : "var(--txt3)", cursor: "pointer" }}>
        {show ? <EyeOff size={16} /> : <Eye size={16} />}
      </button>
    </div>
  );
};

const Seg = ({ options, value, onChange }) => (
  <div style={{ display: "inline-flex", background: "var(--s2)", border: "1px solid var(--bdr)", borderRadius: 9, padding: 3, gap: 2 }}>
    {options.map((o) => (
      <button key={o.k} onClick={() => onChange(o.k)} style={{ padding: "6px 13px", borderRadius: 7, border: "none", cursor: "pointer", fontSize: 12, fontWeight: 600, background: value === o.k ? "var(--s1)" : "transparent", color: value === o.k ? "var(--acc)" : "var(--txt2)", boxShadow: value === o.k ? "0 1px 4px rgba(0,0,0,.12)" : "none", display: "inline-flex", alignItems: "center", gap: 6 }}>
        {o.icon && <o.icon size={13} />}{o.label}
      </button>
    ))}
  </div>
);
const Modal = ({ title, sub, onClose, children, width = 720, footer }) => (
  <div style={{ position: "fixed", inset: 0, background: "rgba(2,6,23,.5)", backdropFilter: "blur(5px)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.(); }}>
    <div className="fade" style={{ width: "100%", maxWidth: width, maxHeight: "92vh", display: "flex", flexDirection: "column", background: "var(--s1)", border: "1px solid var(--bdr)", borderRadius: 14, boxShadow: "0 24px 70px rgba(0,0,0,.35)", overflow: "hidden" }}>
      {title && (
        <div style={{ padding: "14px 20px", borderBottom: "1px solid var(--bdr)", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
          <div><div style={{ fontWeight: 700, fontSize: 15 }}>{title}</div>{sub && <div style={{ fontSize: 12, color: "var(--txt2)", marginTop: 2 }}>{sub}</div>}</div>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "var(--txt2)", cursor: "pointer", padding: 4 }}><X size={18} /></button>
        </div>
      )}
      <div style={{ flex: 1, overflow: "auto", padding: 20 }}>{children}</div>
      {footer && <div style={{ padding: "12px 20px", borderTop: "1px solid var(--bdr)", display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 10, flexWrap: "wrap" }}>{footer}</div>}
    </div>
  </div>
);
const Progress = ({ pct, color = "var(--acc)", h = 6 }) => (
  <div style={{ height: h, background: "var(--s2)", borderRadius: 99, overflow: "hidden", flex: 1 }}>
    <div style={{ height: "100%", width: `${Math.min(100, Math.max(0, pct))}%`, background: color, borderRadius: 99, transition: "width .4s ease" }} />
  </div>
);
const Countdown = ({ task, now }) => {
  if (!task.endTime || task.status === "done") return null;
  const end = hmToDate(task.date, task.endTime);
  const start = task.startTime ? hmToDate(task.date, task.startTime) : null;
  const diff = end - now;
  if (start && now < start) return <span style={{ fontFamily: MONO, fontSize: 11, color: "var(--txt3)" }}>starts {task.startTime}</span>;
  if (diff < 0) return <Pill color="var(--red)"><Clock size={11} /> OVERDUE {fmtDur(-diff)}</Pill>;
  return <Pill color={diff < 15 * 60000 ? "var(--amber)" : "var(--blue)"}><Clock size={11} /> {fmtDur(diff)} left</Pill>;
};
const TypingDots = () => (
  <span style={{ display: "inline-flex", gap: 4, padding: "4px 2px" }}>
    {[0, 1, 2].map((i) => <span key={i} style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--txt3)", animation: `pulseDot .9s ease ${i * 0.18}s infinite` }} />)}
  </span>
);
const Empty = ({ icon: Ic, title, sub }) => (
  <div style={{ padding: "44px 20px", textAlign: "center", color: "var(--txt2)" }}>
    <Ic size={30} style={{ opacity: 0.4, marginBottom: 10 }} />
    <div style={{ fontWeight: 600, color: "var(--txt)", marginBottom: 4 }}>{title}</div>
    <div style={{ fontSize: 12.5, maxWidth: 420, margin: "0 auto", lineHeight: 1.6 }}>{sub}</div>
  </div>
);
const SectionTitle = ({ icon: Ic, children, right }) => (
  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 12 }}>
    <div style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 700, fontSize: 14 }}>{Ic && <Ic size={16} style={{ color: "var(--acc)" }} />}{children}</div>
    {right}
  </div>
);

/* ─── CONTEXT ───────────────────────────────────────────────────────────── */
const Ctx = createContext(null);
const useCtx = () => useContext(Ctx);

/* condition (if/else) renderer — the signature branch rail */
const ConditionRail = ({ conditions }) => {
  if (!conditions || !conditions.length) return null;
  return (
    <div className="branchRail" style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8 }}>
      {conditions.map((c, i) => (
        <div key={i} style={{ background: "var(--s2)", border: "1px solid var(--bdr)", borderRadius: 9, padding: "8px 11px", fontSize: 12.5 }}>
          <div style={{ display: "flex", alignItems: "flex-start", gap: 7, flexWrap: "wrap" }}>
            <Pill color="var(--amber)" style={{ flexShrink: 0 }}><GitBranch size={11} /> IF</Pill>
            <span style={{ color: "var(--txt)", flex: 1, minWidth: 140 }}>{c.if}</span>
          </div>
          <div style={{ display: "flex", alignItems: "flex-start", gap: 7, marginTop: 6, flexWrap: "wrap" }}>
            <Pill color="var(--acc)" style={{ flexShrink: 0 }}><ArrowRight size={11} /> THEN</Pill>
            <span style={{ color: "var(--txt)", flex: 1, minWidth: 140 }}>{c.then}</span>
            {c.timeboxMinutes ? <Pill color="var(--purple)"><Clock size={11} /> {c.timeboxMinutes}m timebox</Pill> : null}
          </div>
        </div>
      ))}
    </div>
  );
};

/* ═══ MODULE 1 — CREATE A PROJECT (chat wizard from previous ODM tool) ═══ */
const PHASES = ["Client", "Contact", "Project", "ID", "Team", "LLD — Customer", "LLD — Designer", "Review"];
const phaseOf = (step) => ({ client: 0, industry: 0, orgsize: 0, clientid: 0, contact: 1, pname: 2, pdesc: 2, deadline: 2, pid: 3, team: 4, lldc: 5, lldq: 5, lldsum: 5, lldd: 6, review: 7, done: 7 }[step] ?? 0);

function ProjectWizard({ onClose }) {
  const { projects, setProjects, clients, setClients, users, me, toast, sheetSync, memory } = useCtx();
  const [msgs, setMsgs] = useState([]);
  const [step, setStep] = useState("boot");
  const [inputOn, setInputOn] = useState(false);
  const [ph, setPh] = useState("Type here…");
  const [val, setVal] = useState("");
  const [typing, setTyping] = useState(false);
  const [lldQ, setLldQ] = useState(0);
  const d = useRef({ clientName: "", industry: null, orgSize: null, clientId: "", existingClient: false, contact: { name: "", designation: "", phone: "", email: "" }, name: "", desc: "", deadline: "", projectId: "", idMode: "auto", team: [], lldC: null, lldD: null, lldAnswers: {} }).current;
  const bodyRef = useRef(null);
  const stepRef = useRef(step);
  stepRef.current = step;
  const scrollDn = () => requestAnimationFrame(() => { if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight; });
  const push = (m) => { setMsgs((x) => [...x, { id: uid(), ...m }]); scrollDn(); };
  const sys = async (text, widget, sub) => { setTyping(true); scrollDn(); await sleep(280); setTyping(false); push({ who: "sys", text, widget, sub }); };
  const meMsg = (text) => push({ who: "me", text });
  const freeze = (id, summary) => setMsgs((x) => x.map((m) => (m.id === id ? { ...m, done: true, summary } : m)));

  const makeClientId = () => `${d.orgSize.code}${d.industry.code}-${String(clients.length + 1).padStart(3, "0")}`;
  const autoPid = () => { const prefix = `EbZ-${d.clientId}-`; const n = projects.filter((p) => (p.projectId || "").startsWith(prefix)).length + 1; return prefix + String(n).padStart(2, "0"); };
  const composeLLDText = () => LLD_QUESTIONS.map((q) => `${q.sec} — ${q.text}\n→ ${Array.isArray(d.lldAnswers[q.id]) ? d.lldAnswers[q.id].join(", ") : d.lldAnswers[q.id] || "TBD"}`).join("\n");

  const go = useCallback(async (s) => {
    setStep(s); setInputOn(false); setVal("");
    switch (s) {
      case "client": await sys("Hi! I'm the Elecbits project assistant — let's set up your new ODM project. **What is the client / company name?**"); setInputOn(true); setPh("e.g. Acme Devices"); break;
      case "industry": await sys(`Which **industry** does ${d.clientName} belong to? This sets the industry code inside the Client ID.`, "industry"); break;
      case "orgsize": await sys("And the **organisation size**?", "orgsize"); break;
      case "clientid": d.clientId = makeClientId(); await sys("Client ID generated from the org-size and industry codes:", "clientid"); break;
      case "contact": await sys(`Who is the **primary contact** at ${d.clientName}?`, "contact"); break;
      case "pname": await sys("**Project name?**"); setInputOn(true); setPh("e.g. ESP32 Sensor Node v2"); break;
      case "pdesc": await sys("One-line description of the project (or type **skip**):"); setInputOn(true); setPh("What are we building, in one line"); break;
      case "deadline": await sys("**Project deadline?** This drives the status board and every countdown.", "deadline"); break;
      case "pid": await sys("**Project ID** — auto-generate the next one in the EbZ sequence, or enter your own manually. Either way, a project cannot exist without one.", "pid"); break;
      case "team": await sys("**Allocate the team.** A PM is mandatory — every R&D member on this project becomes that PM's responsibility.", "team"); break;
      case "lldc": await sys("**LLD for Customer** — fill it through the guided 30-question chat, or upload / paste it manually. This is a hard gate: no customer LLD, no project.", "lldc"); break;
      case "lldq": { const q = LLD_QUESTIONS[lldQRef.current]; await sys(`**Q${lldQRef.current + 1}/30 · ${q.sec}** — ${q.text}`, q.type === "chips" ? "lldchips" : null, q.hint); if (q.type === "text") { setInputOn(true); setPh("Answer, or type skip"); } break; }
      case "lldsum": { const answered = LLD_QUESTIONS.filter((q) => d.lldAnswers[q.id] && d.lldAnswers[q.id] !== "TBD").length; d.lldC = { mode: "chat", answers: { ...d.lldAnswers }, text: composeLLDText(), fileName: "" }; await sys(`Customer LLD captured through chat — **${answered}/30 answered**, the rest marked TBD.`, "lldsumw"); break; }
      case "lldd": await sys("**LLD for Designer** — generate it with AI from the customer LLD, or upload / paste it manually. Also a hard gate.", "lldd"); break;
      case "review": await sys("Here's the full picture. Every item in the required checklist must be green before the project can be created.", "review"); break;
      case "done": await sys(`Project **${d.projectId}** created and appended to the projects sheet. The Drive folder ${pmPath(d.projectId)} with Checklist.xlsx is initialised (simulated sync).`, "donew"); break;
      default: break;
    }
  }, []);
  const lldQRef = useRef(0);
  useEffect(() => { lldQRef.current = lldQ; }, [lldQ]);
  useEffect(() => { go("client"); }, []); // eslint-disable-line

  const nextLLD = async (ansSummary) => {
    if (ansSummary) meMsg(ansSummary);
    const nxt = lldQRef.current + 1;
    if (nxt >= LLD_QUESTIONS.length) { go("lldsum"); } else { setLldQ(nxt); lldQRef.current = nxt; go("lldq"); }
  };

  const handleSend = async () => {
    const v = val.trim(); if (!v) return;
    meMsg(v); setVal("");
    const s = stepRef.current;
    if (s === "client") {
      d.clientName = v;
      const found = clients.find((c) => c.name.toLowerCase() === v.toLowerCase());
      if (found) { d.clientId = found.clientId; d.existingClient = true; await sys(`Found **${found.name}** in the client database — reusing Client ID **${found.clientId}**.`); go("contact"); }
      else go("industry");
    } else if (s === "pname") { d.name = v; go("pdesc"); }
    else if (s === "pdesc") { d.desc = v.toLowerCase() === "skip" ? "" : v; go("deadline"); }
    else if (s === "lldq") { const q = LLD_QUESTIONS[lldQRef.current]; d.lldAnswers[q.id] = v.toLowerCase() === "skip" ? "TBD" : v; setInputOn(false); nextLLD(null); }
  };

  /* ── inline widgets ── */
  const IndustryW = ({ m }) => m.done ? <Done s={m.summary} /> : (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 6, maxWidth: 560 }}>
      {INDUSTRY_CODES.map((it) => (
        <button key={it.code} onClick={() => { d.industry = it; freeze(m.id, `${it.label} · code ${it.code}`); meMsg(it.label); go("orgsize"); }} style={chipS(false)}>{it.label} <span style={{ fontFamily: MONO, color: "var(--txt3)", fontSize: 10 }}>{it.code}</span></button>
      ))}
    </div>
  );
  const OrgW = ({ m }) => m.done ? <Done s={m.summary} /> : (
    <div style={{ display: "flex", flexDirection: "column", gap: 7, maxWidth: 420 }}>
      {ORG_SIZES.map((o) => (
        <button key={o.code} onClick={() => { d.orgSize = o; freeze(m.id, o.label); meMsg(o.label); go("clientid"); }} style={{ ...chipS(false), justifyContent: "space-between", display: "flex", width: "100%", textAlign: "left" }}>{o.label}<span style={{ fontFamily: MONO, color: "var(--txt3)" }}>{o.code}</span></button>
      ))}
    </div>
  );
  const ClientIdW = ({ m }) => m.done ? <Done s={m.summary} /> : (
    <div style={{ maxWidth: 380 }}>
      <div style={{ display: "flex", gap: 7, alignItems: "center", marginBottom: 10, flexWrap: "wrap" }}>
        <Pill color="var(--purple)">{d.orgSize?.code} org</Pill><span style={{ color: "var(--txt3)" }}>+</span>
        <Pill color="var(--blue)">{d.industry?.code} industry</Pill><span style={{ color: "var(--txt3)" }}>+</span>
        <Pill color="var(--green)">{String(clients.length + 1).padStart(3, "0")} seq</Pill>
      </div>
      <div style={{ fontFamily: MONO, fontSize: 22, fontWeight: 600, letterSpacing: ".04em", marginBottom: 12 }}>{d.clientId}</div>
      <Btn small onClick={() => { freeze(m.id, `Client ID ${d.clientId}`); go("contact"); }}>Continue</Btn>
    </div>
  );
  const ContactW = ({ m }) => {
    const [c, setC] = useState({ name: "", designation: "", phone: "", email: "" });
    if (m.done) return <Done s={m.summary} />;
    return (
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, maxWidth: 460 }}>
        <Field label="Name" req><input className="inp" value={c.name} onChange={(e) => setC({ ...c, name: e.target.value })} placeholder="Rajesh Kumar" /></Field>
        <Field label="Designation"><input className="inp" value={c.designation} onChange={(e) => setC({ ...c, designation: e.target.value })} placeholder="CTO" /></Field>
        <Field label="Phone"><input className="inp" value={c.phone} onChange={(e) => setC({ ...c, phone: e.target.value })} placeholder="+91 …" /></Field>
        <Field label="Email"><input className="inp" value={c.email} onChange={(e) => setC({ ...c, email: e.target.value })} placeholder="name@client.com" /></Field>
        <div style={{ gridColumn: "1 / -1" }}><Btn small disabled={!c.name.trim()} onClick={() => { d.contact = c; freeze(m.id, `${c.name}${c.designation ? " · " + c.designation : ""}`); meMsg(c.name); go("pname"); }}>Continue</Btn></div>
      </div>
    );
  };
  const DeadlineW = ({ m }) => {
    const [dl, setDl] = useState("");
    if (m.done) return <Done s={m.summary} />;
    const quick = [["+2 weeks", 14], ["+1 month", 30], ["+2 months", 60], ["+3 months", 90]];
    return (
      <div style={{ maxWidth: 380 }}>
        <input type="date" className="inp" min={todayStr()} value={dl} onChange={(e) => setDl(e.target.value)} />
        <div style={{ display: "flex", gap: 6, margin: "9px 0", flexWrap: "wrap" }}>
          {quick.map(([l, days]) => <button key={l} style={chipS(false)} onClick={() => setDl(new Date(Date.now() + days * 86400000).toISOString().slice(0, 10))}>{l}</button>)}
        </div>
        <Btn small disabled={!dl} onClick={() => { d.deadline = dl; freeze(m.id, fmtDate(dl)); meMsg(fmtDate(dl)); go("pid"); }}>Set deadline</Btn>
      </div>
    );
  };
  const PidW = ({ m }) => {
    const [mode, setMode] = useState("auto");
    const [manual, setManual] = useState("");
    if (m.done) return <Done s={m.summary} />;
    const auto = autoPid();
    const clean = manual.trim().toUpperCase();
    const dupe = clean && projects.some((p) => normId(p.projectId) === normId(clean));
    const badChars = clean && !/^[A-Z0-9][A-Z0-9-]*$/.test(clean);
    const valid = mode === "auto" || (clean && !dupe && !badChars);
    const chosen = mode === "auto" ? auto : clean;
    return (
      <div style={{ maxWidth: 430 }}>
        <Seg value={mode} onChange={setMode} options={[{ k: "auto", label: "Auto-generate" }, { k: "manual", label: "Enter manually" }]} />
        {mode === "auto" ? (
          <div style={{ marginTop: 12 }}>
            <div style={{ fontFamily: MONO, fontSize: 20, fontWeight: 600 }}>{auto}</div>
            <div style={{ fontSize: 11.5, color: "var(--txt2)", marginTop: 4 }}>Next in sequence for client {d.clientId} — same EbZ format as the previous ODM tool.</div>
          </div>
        ) : (
          <div style={{ marginTop: 12 }}>
            <input className="inp" style={{ fontFamily: MONO }} value={manual} onChange={(e) => setManual(e.target.value)} placeholder="e.g. ESP32-124" />
            {dupe && <div style={{ color: "var(--red)", fontSize: 11.5, marginTop: 5 }}>That Project ID already exists — IDs must be unique.</div>}
            {badChars && <div style={{ color: "var(--red)", fontSize: 11.5, marginTop: 5 }}>Use letters, numbers and dashes only.</div>}
          </div>
        )}
        <div style={{ marginTop: 12 }}><Btn small disabled={!valid} onClick={() => { d.projectId = chosen; d.idMode = mode; freeze(m.id, `${chosen} (${mode})`); meMsg(chosen); go("team"); }}>Lock Project ID</Btn></div>
      </div>
    );
  };
  const TeamW = ({ m }) => {
    const [rows, setRows] = useState(TEAM_SLOTS.map((s) => ({ slot: s, userId: "" })));
    if (m.done) return <Done s={m.summary} />;
    const pmOk = rows.some((r) => r.slot.startsWith("PM") && r.userId);
    const set = (i, v) => setRows(rows.map((r, j) => (j === i ? { ...r, userId: v } : r)));
    return (
      <div style={{ maxWidth: 470 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
          {rows.map((r, i) => (
            <div key={r.slot} style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 12, width: 195, color: "var(--txt2)", fontWeight: 600 }}>{r.slot}{r.slot.startsWith("PM") && <span style={{ color: "var(--red)" }}> *</span>}</span>
              <select className="inp" style={{ flex: 1 }} value={r.userId} onChange={(e) => set(i, e.target.value)}>
                <option value="">— unassigned —</option>
                {users.filter((u) => u.role !== "superadmin").map((u) => <option key={u.id} value={u.id}>{u.name} — {u.title}</option>)}
              </select>
            </div>
          ))}
        </div>
        {!pmOk && <div style={{ color: "var(--amber)", fontSize: 11.5, marginTop: 8, display: "flex", gap: 6, alignItems: "center" }}><AlertTriangle size={13} /> A PM must be assigned before continuing.</div>}
        <div style={{ marginTop: 11 }}><Btn small disabled={!pmOk} onClick={() => { d.team = rows.filter((r) => r.userId); freeze(m.id, d.team.map((t) => users.find((u) => u.id === t.userId)?.name).join(", ")); go("lldc"); }}>Confirm team</Btn></div>
      </div>
    );
  };
  const ManualLLD = ({ onUse, kind }) => {
    const [text, setText] = useState("");
    const [fileName, setFileName] = useState("");
    const [fileTxt, setFileTxt] = useState("");
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 9, marginTop: 10 }}>
        <textarea className="inp" rows={5} value={text} onChange={(e) => setText(e.target.value)} placeholder={`Paste the ${kind} LLD content here…`} />
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, color: "var(--txt2)", cursor: "pointer" }}>
          <Upload size={14} />
          <span>{fileName ? <span style={{ color: "var(--txt)", fontFamily: MONO, fontSize: 12 }}>{fileName}</span> : "…or attach a file (name stored; text files are read for AI use)"}</span>
          <input type="file" style={{ display: "none" }} onChange={(e) => { const f = e.target.files[0]; if (!f) return; setFileName(f.name); if (/\.(txt|md|json|csv)$/i.test(f.name)) { const r = new FileReader(); r.onload = () => setFileTxt(String(r.result).slice(0, 8000)); r.readAsText(f); } }} />
        </label>
        <div><Btn small disabled={!text.trim() && !fileName} icon={CheckCircle2} onClick={() => onUse({ mode: "manual", text: text.trim() || fileTxt || `(content in attached file ${fileName})`, fileName })}>Use this LLD</Btn></div>
        <div style={{ fontSize: 11, color: "var(--txt3)" }}>Stored as a reference here; the assistant can push it into the project folder in Drive.</div>
      </div>
    );
  };
  const LldChoiceC = ({ m }) => {
    const [mode, setMode] = useState(null);
    if (m.done) return <Done s={m.summary} />;
    return (
      <div style={{ maxWidth: 470 }}>
        <div style={{ display: "flex", gap: 9, flexWrap: "wrap" }}>
          <ChoiceCard on={mode === "chat"} title="Guided chat" sub="30 questions, chips + text — same flow as the previous tool" icon={Bot} onClick={() => { setLldQ(0); lldQRef.current = 0; freeze(m.id, "Guided chat (30 Qs)"); go("lldq"); }} />
          <ChoiceCard on={mode === "manual"} title="Upload / paste manually" sub="Bring an existing customer LLD" icon={Upload} onClick={() => setMode("manual")} />
        </div>
        {mode === "manual" && <ManualLLD kind="customer" onUse={(lld) => { d.lldC = lld; freeze(m.id, `Manual — ${lld.fileName || lld.text.slice(0, 40) + "…"}`); go("lldd"); }} />}
      </div>
    );
  };
  const LldChips = ({ m }) => {
    const q = LLD_QUESTIONS[m.qIdx];
    const [sel, setSel] = useState([]);
    if (m.done) return <Done s={m.summary} />;
    const pick = (c) => {
      if (q.multi) { setSel((s) => (s.includes(c) ? s.filter((x) => x !== c) : [...s, c])); }
      else { d.lldAnswers[q.id] = c; freeze(m.id, c); nextLLD(c); }
    };
    return (
      <div style={{ maxWidth: 520 }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {q.chips.map((c) => <button key={c} style={chipS(sel.includes(c))} onClick={() => pick(c)}>{c}</button>)}
        </div>
        <div style={{ display: "flex", gap: 10, marginTop: 10, alignItems: "center" }}>
          {q.multi && <Btn small disabled={!sel.length} onClick={() => { d.lldAnswers[q.id] = sel; freeze(m.id, sel.join(", ")); nextLLD(sel.join(", ")); }}>Continue</Btn>}
          <button style={{ background: "none", border: "none", color: "var(--txt3)", fontSize: 12, cursor: "pointer", textDecoration: "underline" }} onClick={() => { d.lldAnswers[q.id] = "TBD"; freeze(m.id, "Skipped — TBD"); nextLLD("skip"); }}>skip</button>
        </div>
      </div>
    );
  };
  const LldSumW = ({ m }) => m.done ? <Done s={m.summary} /> : (
    <div><Btn small onClick={() => { freeze(m.id, "Customer LLD locked"); go("lldd"); }} icon={CheckCircle2}>Continue to Designer LLD</Btn></div>
  );
  const LlddW = ({ m }) => {
    const [mode, setMode] = useState(null);
    const [gen, setGen] = useState("");
    const [busy, setBusy] = useState(false);
    const [err, setErr] = useState("");
    if (m.done) return <Done s={m.summary} />;
    const generate = async () => {
      setBusy(true); setErr("");
      try { const txt = await claude(designerPrompt(d.lldC?.text || "", d.name, memory), { json: false }); setGen(txt); }
      catch (e) { setErr("AI unreachable (" + e.message + ") — you can load the offline template and edit it."); }
      setBusy(false);
    };
    return (
      <div style={{ maxWidth: 520 }}>
        <div style={{ display: "flex", gap: 9, flexWrap: "wrap" }}>
          <ChoiceCard on={mode === "ai"} title="Generate with AI" sub="Translated from the customer LLD + system memory" icon={Sparkles} onClick={() => { setMode("ai"); if (!gen) generate(); }} />
          <ChoiceCard on={mode === "manual"} title="Upload / paste manually" sub="Bring your own designer LLD" icon={Upload} onClick={() => setMode("manual")} />
        </div>
        {mode === "ai" && (
          <div style={{ marginTop: 10 }}>
            {busy ? <div style={{ display: "flex", gap: 8, alignItems: "center", color: "var(--txt2)", fontSize: 12.5 }}><Loader2 className="spin" size={14} /> Translating the customer LLD into engineering language…</div> : (
              <>
                {err && <div style={{ color: "var(--amber)", fontSize: 12, marginBottom: 7 }}>{err} <button style={{ background: "none", border: "none", color: "var(--acc)", cursor: "pointer", textDecoration: "underline", fontSize: 12 }} onClick={() => setGen(fallbackDesigner(d.lldC?.text || "", d.name))}>Load template</button> · <button style={{ background: "none", border: "none", color: "var(--acc)", cursor: "pointer", textDecoration: "underline", fontSize: 12 }} onClick={generate}>Retry AI</button></div>}
                {gen && <>
                  <textarea className="inp" rows={11} style={{ fontSize: 12.5, lineHeight: 1.55 }} value={gen} onChange={(e) => setGen(e.target.value)} />
                  <div style={{ marginTop: 9 }}><Btn small icon={CheckCircle2} onClick={() => { d.lldD = { mode: "ai", text: gen, fileName: "" }; freeze(m.id, "AI-generated (edited & accepted)"); go("review"); }}>Accept Designer LLD</Btn></div>
                </>}
              </>
            )}
          </div>
        )}
        {mode === "manual" && <ManualLLD kind="designer" onUse={(lld) => { d.lldD = lld; freeze(m.id, `Manual — ${lld.fileName || lld.text.slice(0, 40) + "…"}`); go("review"); }} />}
      </div>
    );
  };
  const ReviewW = ({ m }) => {
    const gates = [
      ["Project ID", !!d.projectId], ["Customer LLD", !!d.lldC], ["Designer LLD", !!d.lldD],
      ["PM assigned", d.team.some((t) => t.slot.startsWith("PM"))], ["Deadline set", !!d.deadline], ["Client & name", !!d.clientName && !!d.name],
    ];
    const allOk = gates.every((g) => g[1]);
    if (m.done) return <Done s={m.summary} />;
    return (
      <div style={{ maxWidth: 540 }}>
        <div className="card" style={{ padding: 14, marginBottom: 12 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px 16px", fontSize: 12.5 }}>
            <KV k="Client" v={`${d.clientName} · ${d.clientId}`} />
            <KV k="Contact" v={d.contact.name || "—"} />
            <KV k="Project" v={d.name} />
            <KV k="Deadline" v={fmtDate(d.deadline)} />
            <KV k="Project ID" v={<span style={{ fontFamily: MONO }}>{d.projectId} <span style={{ color: "var(--txt3)", fontSize: 10 }}>({d.idMode})</span></span>} />
            <KV k="Team" v={d.team.map((t) => users.find((u) => u.id === t.userId)?.name).join(", ") || "—"} />
            <KV k="Customer LLD" v={d.lldC ? (d.lldC.mode === "chat" ? "Guided chat" : "Manual upload") : "—"} />
            <KV k="Designer LLD" v={d.lldD ? (d.lldD.mode === "ai" ? "AI-generated" : "Manual upload") : "—"} />
          </div>
        </div>
        <div style={{ fontSize: 11, fontWeight: 700, color: "var(--txt2)", textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 7 }}>Required — no project without all of these</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 5, marginBottom: 13 }}>
          {gates.map(([label, ok]) => (
            <div key={label} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5 }}>
              {ok ? <CheckCircle2 size={15} style={{ color: "var(--green)" }} /> : <X size={15} style={{ color: "var(--red)" }} />}
              <span style={{ color: ok ? "var(--txt)" : "var(--red)", fontWeight: ok ? 500 : 600 }}>{label}</span>
            </div>
          ))}
        </div>
        <Btn disabled={!allOk} icon={FolderPlus} onClick={() => {
          const p = { id: uid(), projectId: d.projectId, idMode: d.idMode, name: d.name, desc: d.desc, clientName: d.clientName, clientId: d.clientId, industry: d.industry?.label || "", orgSize: d.orgSize?.label || "", contact: d.contact, deadline: d.deadline, status: "Planning", team: d.team, lldCustomer: d.lldC, lldDesigner: d.lldD, createdAt: new Date().toISOString(), createdBy: me };
          setProjects((x) => [p, ...x]);
          if (!d.existingClient && d.clientId) setClients((x) => [...x, { id: uid(), clientId: d.clientId, name: d.clientName }]);
          sheetSync("Project Data and IDs (Google Sheet)", `${d.projectId} appended`);
          sheetSync(`Drive ${pmPath(d.projectId)}`, "Folder + Checklist.xlsx initialised");
          toast(`Project ${d.projectId} created`, "green");
          freeze(m.id, "Project created"); go("done");
        }}>Create project</Btn>
        {!allOk && <div style={{ fontSize: 11.5, color: "var(--txt2)", marginTop: 7 }}>Complete the red items above — the button unlocks automatically.</div>}
      </div>
    );
  };
  const DoneW = () => <div><Btn small kind="green" icon={CheckCircle2} onClick={onClose}>Done — view in the projects list</Btn></div>;

  const WIDGETS = { industry: IndustryW, orgsize: OrgW, clientid: ClientIdW, contact: ContactW, deadline: DeadlineW, pid: PidW, team: TeamW, lldc: LldChoiceC, lldchips: LldChips, lldsumw: LldSumW, lldd: LlddW, review: ReviewW, donew: DoneW };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(2,6,23,.5)", backdropFilter: "blur(5px)", zIndex: 1200, display: "flex", alignItems: "center", justifyContent: "center", padding: 14 }}>
      <div className="fade" style={{ width: "100%", maxWidth: 920, height: "92vh", display: "flex", flexDirection: "column", borderRadius: 14, overflow: "hidden", background: "var(--s1)", boxShadow: "0 24px 80px rgba(0,0,0,.4)", border: "1px solid var(--bdr)" }}>
        <div style={{ background: "linear-gradient(135deg,#1e3a8a,#2563eb)", padding: "14px 20px 0" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
              <span style={{ width: 34, height: 34, borderRadius: 8, background: "rgba(255,255,255,.15)", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800, color: "#fff", fontFamily: MONO, fontSize: 13 }}>Eb</span>
              <div>
                <div style={{ fontSize: 15, fontWeight: 700, color: "#fff" }}>New ODM project</div>
                <div style={{ fontSize: 11, color: "rgba(255,255,255,.6)" }}>Project + status only — execution starts in Daily Scrum</div>
              </div>
            </div>
            <button onClick={onClose} style={{ background: "none", border: "none", color: "rgba(255,255,255,.7)", cursor: "pointer" }}><X size={19} /></button>
          </div>
          <div style={{ display: "flex", gap: 2, overflowX: "auto" }}>
            {PHASES.map((p, i) => (
              <span key={p} style={{ padding: "7px 11px", fontSize: 10.5, fontWeight: phaseOf(step) === i ? 700 : 500, color: "#fff", opacity: phaseOf(step) === i ? 1 : phaseOf(step) > i ? 0.72 : 0.35, borderBottom: phaseOf(step) === i ? "2px solid #fff" : "2px solid transparent", whiteSpace: "nowrap" }}>{p}</span>
            ))}
          </div>
        </div>
        <div ref={bodyRef} style={{ flex: 1, overflow: "auto", padding: "18px 22px", display: "flex", flexDirection: "column", gap: 11, background: "var(--bg)" }}>
          {msgs.map((m) => {
            const W = m.widget ? WIDGETS[m.widget] : null;
            return (
              <div key={m.id} className="fade" style={{ display: "flex", justifyContent: m.who === "me" ? "flex-end" : "flex-start", gap: 8 }}>
                {m.who === "sys" && <span style={{ width: 26, height: 26, borderRadius: "50%", background: "var(--s2)", border: "1px solid var(--bdr)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9, fontWeight: 800, color: "var(--txt2)", flexShrink: 0, fontFamily: MONO, marginTop: 2 }}>Eb</span>}
                <div style={{ maxWidth: "82%", display: "flex", flexDirection: "column", gap: 8 }}>
                  {m.text && (
                    <div style={{ padding: "10px 14px", borderRadius: m.who === "me" ? "13px 13px 4px 13px" : "13px 13px 13px 4px", background: m.who === "me" ? "linear-gradient(135deg,#2563eb,#1e40af)" : "var(--s1)", border: m.who === "me" ? "none" : "1px solid var(--bdr)", color: m.who === "me" ? "#fff" : "var(--txt)", fontSize: 13.5, lineHeight: 1.55 }}>
                      <MD t={m.text} />
                      {m.sub && <div style={{ fontSize: 11.5, color: m.who === "me" ? "rgba(255,255,255,.75)" : "var(--txt2)", marginTop: 4, fontStyle: "italic" }}>{m.sub}</div>}
                    </div>
                  )}
                  {W && <div style={{ background: "var(--s1)", border: "1px solid var(--bdr)", borderRadius: 12, padding: 14 }}><W m={{ ...m, qIdx: m.widget === "lldchips" ? lldQForMsg(m, msgs) : 0 }} /></div>}
                </div>
              </div>
            );
          })}
          {typing && <div style={{ display: "flex", gap: 8 }}><span style={{ width: 26, height: 26, borderRadius: "50%", background: "var(--s2)", border: "1px solid var(--bdr)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9, fontWeight: 800, color: "var(--txt2)", fontFamily: MONO }}>Eb</span><div style={{ padding: "8px 14px", borderRadius: 13, background: "var(--s1)", border: "1px solid var(--bdr)" }}><TypingDots /></div></div>}
        </div>
        <div style={{ padding: "11px 18px", borderTop: "1px solid var(--bdr)", background: "var(--s1)", display: "flex", gap: 9 }}>
          <input className="inp" style={{ flex: 1, opacity: inputOn ? 1 : 0.5 }} disabled={!inputOn} placeholder={inputOn ? ph : "Use the options above…"} value={val} onChange={(e) => setVal(e.target.value)} onKeyDown={(e) => e.key === "Enter" && handleSend()} />
          <Btn disabled={!inputOn || !val.trim()} onClick={handleSend} icon={Send} style={{ width: 44, padding: 0 }} title="Send"> </Btn>
        </div>
      </div>
    </div>
  );
}
/* chip question index: count lldchips widgets before this one */
const lldQForMsg = (m, msgs) => {
  /* deterministic: the nth lldchips widget corresponds to the nth chips-type question */
  let count = -1; for (const x of msgs) { if (x.widget === "lldchips") count += 1; if (x.id === m.id) break; }
  /* map nth chip widget to its question index */
  let seen = -1; for (let qi = 0; qi < LLD_QUESTIONS.length; qi++) { if (LLD_QUESTIONS[qi].type === "chips") { seen += 1; if (seen === count) return qi; } }
  return 0; };
const chipS = (on) => ({ padding: "6px 13px", borderRadius: 99, border: `1.5px solid ${on ? "var(--acc)" : "var(--bdr)"}`, background: on ? "var(--soft)" : "var(--s1)", color: on ? "var(--acc)" : "var(--txt)", fontSize: 12, fontWeight: 600, cursor: "pointer", transition: "all .15s" });
const Done = ({ s }) => <div style={{ display: "flex", alignItems: "center", gap: 7, color: "var(--txt2)", fontSize: 12.5 }}><CheckCircle2 size={14} style={{ color: "var(--green)" }} /> {s}</div>;
const KV = ({ k, v }) => <div><div style={{ fontSize: 10, fontWeight: 700, color: "var(--txt3)", textTransform: "uppercase", letterSpacing: ".05em" }}>{k}</div><div style={{ marginTop: 2 }}>{v}</div></div>;
const ChoiceCard = ({ title, sub, icon: Ic, onClick, on }) => (
  <button onClick={onClick} style={{ flex: 1, minWidth: 190, textAlign: "left", padding: "13px 15px", borderRadius: 11, border: `2px solid ${on ? "var(--acc)" : "var(--bdr)"}`, background: on ? "var(--soft)" : "var(--s1)", cursor: "pointer", transition: "all .15s" }}>
    <div style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 700, fontSize: 13, marginBottom: 4 }}><Ic size={15} style={{ color: "var(--acc)" }} /> {title}</div>
    <div style={{ fontSize: 11.5, color: "var(--txt2)", lineHeight: 1.5 }}>{sub}</div>
  </button>
);

/* ═══ MODULE 1 BODY — PROJECTS LIST ══════════════════════════════════════ */
function ProjectsModule() {
  const { projects, setProjects, users, me, sheetSync, toast } = useCtx();
  const my = users.find((u) => u.id === me);
  const isAdmin = my?.role === "superadmin";
  const [addExisting, setAddExisting] = useState(false);
  const [openId, setOpenId] = useState(null);
  const setStatus = (id, status) => { setProjects((ps) => ps.map((p) => (p.id === id ? { ...p, status } : p))); sheetSync("Project Data and IDs (Google Sheet)", `Status → ${status}`); };
  const openProject = projects.find((p) => p.id === openId);
  if (openProject) return <ProjectDetail project={openProject} onBack={() => setOpenId(null)} setStatus={setStatus} isAdmin={isAdmin} />;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div className="card" style={{ padding: 18, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div>
          <div style={{ fontWeight: 700, fontSize: 15 }}>Projects</div>
          <div style={{ fontSize: 12.5, color: "var(--txt2)", marginTop: 3 }}>Add an in-flight project by ID — PM, linked IDs, team, timeline and its known status. The OS reads its PM + PCB Drive folders and tells you how it's moving.</div>
        </div>
        {isAdmin ? <Btn icon={Plus} onClick={() => setAddExisting(true)}>Add existing project</Btn> : <Pill color="var(--txt2)"><Shield size={11} /> Adding is admin-only</Pill>}
      </div>
      {projects.length === 0 ? (
        <div className="card"><Empty icon={FolderPlus} title="No projects yet" sub="Add an existing project — enter its Project ID, PM, linked PCB IDs, team, timeline and known status, and the OS starts tracking it." /></div>
      ) : projects.map((p) => {
        const dl = daysLeft(p.deadline);
        const pm = p.team?.find((t) => t.slot.startsWith("PM"));
        return (
          <div key={p.id} className="card rowHover" style={{ padding: 16, cursor: "pointer" }} onClick={() => setOpenId(p.id)} title="Open full progress & to-dos">
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
              <div style={{ minWidth: 240, flex: 1 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap" }}>
                  <span style={{ fontFamily: MONO, fontWeight: 600, fontSize: 13.5, color: "var(--acc)" }}>{p.projectId}</span>
                  {p.idMode === "manual" && <Pill color="var(--txt3)">manual ID</Pill>}
                  {Date.now() - new Date(p.createdAt).getTime() < 7 * 86400000 && <Pill color="var(--green)"><Zap size={10} /> NEW</Pill>}
                </div>
                <div style={{ fontWeight: 700, fontSize: 14.5, margin: "4px 0 2px" }}>{p.name}</div>
                <div style={{ fontSize: 12, color: "var(--txt2)" }}>{p.clientName} · {p.clientId}{pm ? ` · PM: ${users.find((u) => u.id === pm.userId)?.name}` : ""}</div>
                <div style={{ fontFamily: MONO, fontSize: 10.5, color: "var(--txt3)", marginTop: 5 }}>{pmPath(p.projectId)} → Checklist.xlsx</div>
                <div style={{ display: "flex", alignItems: "center", gap: 4, marginTop: 7, fontSize: 11.5, fontWeight: 600, color: "var(--acc)" }}>View full progress &amp; to-dos <ArrowRight size={12} /></div>
              </div>
              <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 8 }}>
                {isAdmin ? (
                  <select className="inp" style={{ width: 150, padding: "6px 10px", fontWeight: 600, color: statColor(p.status) }} value={p.status} onClick={(e) => e.stopPropagation()} onChange={(e) => setStatus(p.id, e.target.value)}>
                    {STATUSES.map((s) => <option key={s.k} value={s.k}>{s.k}</option>)}
                  </select>
                ) : <Pill color={statColor(p.status)}>{p.status}</Pill>}
                <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <Pill color={dl < 0 ? "var(--red)" : dl <= 7 ? "var(--amber)" : "var(--txt2)"}><Calendar size={11} /> {fmtDate(p.deadline)} · {dl < 0 ? `${-dl}d over` : `${dl}d left`}</Pill>
                </div>
                <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", justifyContent: "flex-end" }}>
                  {p.origin === "existing" && <Pill color="var(--purple)"><FolderPlus size={10} /> existing</Pill>}
                  {(p.linkedIds || []).length > 0 && <Pill color="var(--blue)"><FileText size={10} /> {p.linkedIds.length} linked ID{p.linkedIds.length > 1 ? "s" : ""}</Pill>}
                  {p.lldCustomer && <Pill color="var(--green)"><FileText size={10} /> C-LLD · {p.lldCustomer.mode}</Pill>}
                  {p.lldDesigner && <Pill color="var(--green)"><FileText size={10} /> D-LLD · {p.lldDesigner.mode}</Pill>}
                </div>
                <div style={{ display: "flex" }}>{(p.team || []).map((t, i) => <span key={i} style={{ marginLeft: i ? -7 : 0 }}><AvatarDot user={users.find((u) => u.id === t.userId)} size={24} /></span>)}</div>
              </div>
            </div>
          </div>
        );
      })}
      {addExisting && <AddExistingProject onClose={() => setAddExisting(false)} />}
    </div>
  );
}

/* ═══ ADD EXISTING PROJECT ═══════════════════════════════════════════════
   Register an in-flight project: Project ID, PM, linked (GW/PCB) IDs, team,
   timeline, and a known-status paragraph. No LLD gates — this is an existing
   project the OS starts tracking (Drive intelligence lives in the detail view). */
function AddExistingProject({ onClose }) {
  const { projects, setProjects, users, me, toast, sheetSync, memory, setMemory } = useCtx();
  const [learning, setLearning] = useState("");
  const [learnBusy, setLearnBusy] = useState(false);
  const [projectId, setProjectId] = useState("");
  const [name, setName] = useState("");
  const [pmId, setPmId] = useState("");
  const [linked, setLinked] = useState([""]);
  const [rows, setRows] = useState(TEAM_SLOTS.filter((s) => !s.startsWith("PM")).map((s) => ({ slot: s, userId: "" })));
  const [startDate, setStartDate] = useState(todayStr());
  const [deadline, setDeadline] = useState("");
  const [status, setStatus] = useState("In Progress");
  const [knownStatus, setKnownStatus] = useState("");
  const clean = projectId.trim().toUpperCase();
  const dupe = clean && projects.some((p) => normId(p.projectId) === normId(clean));
  const badChars = clean && !/^[A-Z0-9][A-Z0-9-]*$/.test(clean);
  const valid = clean && !dupe && !badChars && name.trim() && pmId && deadline;
  const setLink = (i, v) => setLinked((l) => l.map((x, j) => (j === i ? v : x)));
  const setRow = (i, v) => setRows((r) => r.map((x, j) => (j === i ? { ...x, userId: v } : x)));
  const learnFromDrive = async () => {
    const ids = linked.map((x) => x.trim().toUpperCase()).filter(Boolean);
    setLearnBusy(true);
    const { digest, error: driveErr } = await driveReadDigest(clean, ids, { scope: driveScope(me && users.find((u) => u.id === me)?.role) });
    if (driveErr) toast(driveErr, "amber");
    try { const txt = await claude(driveLearnPrompt(clean || "(new project)", ids, knownStatus, memory, digest), { json: false }); setLearning(txt); if (digest) toast("Learned from live Drive contents", "green"); }
    catch { setLearning(fallbackLearn(clean || "(new project)", ids, knownStatus)); toast("AI offline — template learning loaded, edit freely", "amber"); }
    setLearnBusy(false);
  };
  const submit = () => {
    if (!valid) return;
    const team = [{ slot: "PM (Project Manager)", userId: pmId }, ...rows.filter((r) => r.userId)];
    const p = {
      id: uid(), projectId: clean, idMode: "manual", origin: "existing", name: name.trim(),
      clientName: "", clientId: "", industry: "", orgSize: "", contact: {},
      linkedIds: linked.map((x) => x.trim().toUpperCase()).filter(Boolean),
      team, startDate, deadline, status, knownStatus: knownStatus.trim(),
      lldCustomer: null, lldDesigner: null, intelligence: [], chat: [],
      driveLearning: learning.trim() || null,
      createdAt: new Date().toISOString(), createdBy: me,
    };
    setProjects((x) => [p, ...x]);
    // The learning becomes a System Memory note — injected into every AI call,
    // so scrum parsing / task allocation / closure checks on this project use it.
    if (learning.trim()) {
      setMemory((m) => [{ id: uid(), type: "note", title: `Drive learning — ${clean}`, content: learning.trim(), createdAt: new Date().toISOString() }, ...m]);
      sheetSync("System Memory", `Drive learning for ${clean} stored`);
    }
    sheetSync("Project Data and IDs (Google Sheet)", `${clean} registered (existing)`);
    sheetSync(`Drive ${pmPath(clean)}`, `Linked to ${p.linkedIds.length} PCB folder(s)`);
    toast(`Project ${clean} added${learning.trim() ? " — Drive learning saved to memory" : ""}`, "green");
    onClose();
  };
  return (
    <Modal title="Add existing project" sub="Register an in-flight project so the OS can track it and read its Drive folders" onClose={onClose} width={720}
      footer={<><Btn kind="ghost" onClick={onClose}>Cancel</Btn><Btn icon={FolderPlus} disabled={!valid} onClick={submit}>Add project</Btn></>}>
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <Field label="Project ID" req>
            <input className="inp" style={{ fontFamily: MONO }} value={projectId} onChange={(e) => setProjectId(e.target.value)} placeholder="e.g. ESP32-124" />
            {dupe && <span style={{ color: "var(--red)", fontSize: 11, marginTop: 4 }}>Already exists — IDs must be unique.</span>}
            {badChars && <span style={{ color: "var(--red)", fontSize: 11, marginTop: 4 }}>Letters, numbers and dashes only.</span>}
          </Field>
          <Field label="Project name" req><input className="inp" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. ESP32 Gateway v2" /></Field>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <Field label="PM (Project Manager)" req>
            <select className="inp" value={pmId} onChange={(e) => setPmId(e.target.value)}>
              <option value="">— choose PM —</option>
              {users.filter((u) => u.role !== "superadmin").map((u) => <option key={u.id} value={u.id}>{u.name} — {u.title}</option>)}
            </select>
          </Field>
          <Field label="Status"><select className="inp" value={status} onChange={(e) => setStatus(e.target.value)}>{STATUSES.map((s) => <option key={s.k} value={s.k}>{s.k}</option>)}</select></Field>
        </div>
        <Field label="Linked IDs (GW / PCB — add multiple)">
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {linked.map((v, i) => (
              <div key={i} style={{ display: "flex", gap: 6 }}>
                <input className="inp" style={{ fontFamily: MONO, flex: 1 }} value={v} onChange={(e) => setLink(i, e.target.value)} placeholder={`e.g. ESP32-124-PCB-R1`} />
                {linked.length > 1 && <button onClick={() => setLinked((l) => l.filter((_, j) => j !== i))} style={{ background: "none", border: "1px solid var(--bdr)", borderRadius: 7, color: "var(--txt3)", cursor: "pointer", padding: "0 10px" }}><X size={13} /></button>}
              </div>
            ))}
            <button onClick={() => setLinked((l) => [...l, ""])} style={{ alignSelf: "flex-start", background: "none", border: "none", color: "var(--acc)", fontSize: 12.5, cursor: "pointer", display: "flex", gap: 5, alignItems: "center" }}><Plus size={13} /> add linked ID</button>
          </div>
        </Field>
        <Field label="Team allocated (optional — PM is set above)">
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            {rows.map((r, i) => (
              <div key={r.slot} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 11, width: 130, color: "var(--txt2)", fontWeight: 600 }}>{r.slot}</span>
                <select className="inp" style={{ flex: 1, padding: "6px 8px" }} value={r.userId} onChange={(e) => setRow(i, e.target.value)}>
                  <option value="">—</option>
                  {users.filter((u) => u.role !== "superadmin").map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                </select>
              </div>
            ))}
          </div>
        </Field>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <Field label="Start date"><input type="date" className="inp" value={startDate} onChange={(e) => setStartDate(e.target.value)} /></Field>
          <Field label="Deadline" req><input type="date" className="inp" value={deadline} min={startDate} onChange={(e) => setDeadline(e.target.value)} /></Field>
        </div>
        <Field label="Known status — what's going on right now (paragraph)">
          <textarea className="inp" rows={4} value={knownStatus} onChange={(e) => setKnownStatus(e.target.value)} placeholder="Where the project stands, what's done, what's pending, blockers, client situation… The OS uses this plus the Drive folders to reason about the project." />
        </Field>
        <div style={{ border: "1px dashed var(--bdr2)", borderRadius: 11, padding: 13, background: "var(--s2)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap" }}>
            <Btn small icon={learnBusy ? Loader2 : Database} disabled={learnBusy || !clean} onClick={learnFromDrive}>{learnBusy ? "Learning from Drive…" : learning ? "Re-learn from Drive" : "Learn from Drive"}</Btn>
            <span style={{ fontSize: 11.5, color: "var(--txt2)", flex: 1, minWidth: 200 }}>Reads the {pmPath(clean || "<ID>")} and linked GW/PCB folders and distils a knowledge note. Saved to System Memory on creation — used for this project's task allocation.</span>
          </div>
          {learnBusy && <div style={{ marginTop: 10, display: "flex", gap: 8, alignItems: "center", color: "var(--txt2)", fontSize: 12 }}><Loader2 className="spin" size={13} /> Reading folder structure, checklist tabs and status — distilling allocation hints…</div>}
          {learning && !learnBusy && (
            <div className="fade" style={{ marginTop: 10 }}>
              <textarea className="inp" rows={7} style={{ fontSize: 12, lineHeight: 1.55, background: "var(--s1)" }} value={learning} onChange={(e) => setLearning(e.target.value)} />
              <div style={{ fontSize: 10.5, color: "var(--txt3)", marginTop: 5 }}>Editable — this exact text becomes the memory note "Drive learning — {clean}".</div>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

/* ── Project detail — complete progress of the sanctioned project + next to-dos.
   Clickable from the projects list. Progress and to-dos are derived from the
   Daily-Scrum tasks linked to this project; layout mirrors the PMS ProjectPage. */
const projTasksCount = (tasks, pid) => tasks.filter((t) => t.projectId === pid).length;
/* The project page, one job at a time. */
const PROJ_TABS = [
  ["overview", "Overview", Gauge, ""],
  ["plan", "Plan", ListChecks, "plan"],
  ["tasks", "To-dos", CheckCircle2, "tasks"],
  ["mom", "Brainstorming", Lightbulb, "mom"],
  ["files", "Files & details", FileText, ""],
  ["chat", "Ask the AI", Bot, ""],
];
/* Is this to-do past its own clock? Module scope so both the project page and
   the card below can ask, without either owning the answer. */
const isOverdue = (t, nowMs) => !!(t.endTime && t.status !== "done" && hmToDate(t.date, t.endTime) < (nowMs || Date.now()));
const todoMeta = (t, nowMs) => t.status === "blocked" ? { Ic: AlertTriangle, label: "Blocked", color: "var(--red)" }
  : isOverdue(t, nowMs) ? { Ic: Clock, label: "Overdue", color: "var(--red)" }
  : t.status === "in-progress" ? { Ic: Play, label: "In progress", color: "var(--blue)" }
  : { Ic: ListChecks, label: "To start", color: "var(--txt2)" };

/* One open to-do on the project page. Given the plan's stages it also carries
   the control to move itself to a different one — the AI's filing is a first
   pass, and the person looking at it always gets the last word. */
function TodoCard({ t, users, stages, onMove, nowMs }) {
  const { Ic, label, color } = todoMeta(t, nowMs);
  const u = users.find((x) => x.id === t.assigneeId);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "11px 13px", border: "1px solid var(--bdr)", borderRadius: 10, background: "var(--s1)" }}>
      <div style={{ width: 34, height: 34, borderRadius: 9, background: "color-mix(in srgb," + color + " 14%,transparent)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}><Ic size={16} style={{ color }} /></div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600, fontSize: 13, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{t.title}</div>
        <div style={{ display: "flex", gap: 8, marginTop: 3, alignItems: "center", flexWrap: "wrap" }}>
          {u ? <span style={{ display: "flex", alignItems: "center", gap: 5 }}><AvatarDot user={u} size={18} /><span style={{ fontSize: 11.5, color: "var(--txt2)" }}>{u.name}</span></span> : <Pill color="var(--amber)">unassigned</Pill>}
          {(t.startTime || t.endTime) && <span style={{ fontFamily: MONO, fontSize: 11, color: "var(--txt2)" }}>{t.startTime || "…"}–{t.endTime || "…"}</span>}
          <span style={{ fontSize: 11, color: "var(--txt3)" }}>{fmtDate(t.date)}</span>
          {t.conditions?.length > 0 && <Pill color="var(--amber)"><GitBranch size={10} /> {t.conditions.length} if/else</Pill>}
          {t.origin === "branch" && <Pill color="var(--purple)"><GitBranch size={10} /> branch</Pill>}
          {t.escalated && <Pill color="var(--red)"><Shield size={10} /> Shreya</Pill>}
        </div>
      </div>
      {stages?.length > 0 && onMove && (
        <select className="inp" title="Move this to-do to another stage" value={t.stageId || ""} onChange={(e) => onMove(t.id, e.target.value)}
          style={{ width: 150, padding: "5px 8px", fontSize: 11.5, flexShrink: 0, background: "var(--s2)" }}>
          <option value="">— no stage —</option>
          {stages.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      )}
      <Pill color={color} style={{ flexShrink: 0 }}>{label}</Pill>
    </div>
  );
}

/* Defined at module scope, NOT inside ProjectDetail: components declared inside
   a component get a new identity on every render, so React unmounts and
   remounts their whole subtree — which made inputs lose focus on each
   keystroke. Keep any component that wraps an input out here. */
const Section = ({ children, style }) => <div className="card" style={{ padding: 16, ...style }}>{children}</div>;
const CardLabel = ({ children, right }) => <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 12 }}><span style={{ fontSize: 11, fontWeight: 700, color: "var(--txt2)", textTransform: "uppercase", letterSpacing: ".06em" }}>{children}</span>{right}</div>;

function ProjectDetail({ project: p, onBack, setStatus, isAdmin }) {
  const { tasks, setTasks, users, notes, me, now, setProjects, memory, setMemory, toast, sheetSync } = useCtx();
  const [confirmDel, setConfirmDel] = useState(false);
  const my = users.find((u) => u.id === me);
  const isPM = isAdmin || my?.role === "pm" || my?.role === "dept_head";
  const [showLLD, setShowLLD] = useState(false);
  const [editTeam, setEditTeam] = useState(false);
  const [teamDraft, setTeamDraft] = useState(p.team || []);
  const [editStatus, setEditStatus] = useState(false);
  const [statusDraft, setStatusDraft] = useState(p.knownStatus || "");
  const [intel, setIntel] = useState(p.driveAnalysis?.text || "");
  const [intelBusy, setIntelBusy] = useState(false);
  const [noteVal, setNoteVal] = useState("");
  const [noteBusy, setNoteBusy] = useState(false);
  const [chatVal, setChatVal] = useState("");
  const [chatBusy, setChatBusy] = useState(false);
  const [planBusy, setPlanBusy] = useState(false);
  const [momVal, setMomVal] = useState("");
  const [momWho, setMomWho] = useState("");
  const [momBusy, setMomBusy] = useState(false);
  const [filing, setFiling] = useState(false);
  const [grouped, setGrouped] = useState(true);
  const [closedStages, setClosedStages] = useState([]);
  const [tab, setTab] = useState("overview");
  const [chatAtts, setChatAtts] = useState([]);
  const chatFileRef = useRef(null);
  const chatLastAtts = useRef([]);      // so "save that here" still works next turn
  const chatRef = useRef(null);
  useEffect(() => { if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight; }, [(p.chat || []).length, chatBusy, chatAtts.length]);
  // patch may be a function of the CURRENT project — a plan write that lands
  // after a slow Drive read must not overwrite what happened meanwhile.
  const upd = (patch) => setProjects((ps) => ps.map((x) => (x.id === p.id ? { ...x, ...(typeof patch === "function" ? patch(x) : patch) } : x)));
  const pRef = useRef(p);
  useEffect(() => { pRef.current = p; });
  const nowMs = now || Date.now();
  const pm = p.team?.find((t) => t.slot.startsWith("PM"));
  const projTasks = tasks.filter((t) => t.projectId === p.projectId);
  const done = projTasks.filter((t) => t.status === "done");
  const openTasks = projTasks.filter((t) => t.status !== "done");
  const pct = projTasks.length ? Math.round((done.length / projTasks.length) * 100) : 0;
  const counts = [
    ["Pending", projTasks.filter((t) => t.status === "pending").length, "var(--txt3)"],
    ["In progress", projTasks.filter((t) => t.status === "in-progress").length, "var(--blue)"],
    ["Blocked", projTasks.filter((t) => t.status === "blocked").length, "var(--amber)"],
    ["Done", done.length, "var(--green)"],
  ];
  const dl = daysLeft(p.deadline);
  const overdue = (t) => isOverdue(t, nowMs);
  const rank = (t) => (t.status === "blocked" ? 0 : overdue(t) ? 1 : t.status === "in-progress" ? 2 : 3);
  const todos = [...openTasks].sort((a, b) => rank(a) - rank(b) || (a.date + (a.startTime || "")).localeCompare(b.date + (b.startTime || "")));
  const planStages = p.plan?.stages || [];
  const unfiled = needsFiling(planStages, todos);
  /* A project with a plan should never show a flat list of to-dos. The first
     time anyone looks at the plan or the to-dos, whatever is loose gets filed
     — no button to find, no project left behind. */
  const autoFiled = useRef(false);
  useEffect(() => {
    if (autoFiled.current || filing) return;
    if (tab !== "tasks" && tab !== "plan") return;
    if (!planStages.length || !unfiled.length) return;
    autoFiled.current = true;
    fileTodos(planStages, { announce: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, planStages.length, unfiled.length]);
  const sanctioned = p.status !== "Planning";
  const timelineStart = p.startDate || (p.createdAt || "").slice(0, 10);
  const startMs = new Date((p.startDate || p.createdAt) + (p.startDate ? "T00:00:00" : "")).getTime();
  const endMs = new Date(p.deadline + "T23:59:59").getTime();
  const elapsedPct = endMs > startMs ? Math.min(100, Math.max(0, Math.round(((nowMs - startMs) / (endMs - startMs)) * 100))) : 100;
  const gates = p.origin === "existing"
    ? [["Project ID", !!p.projectId], ["PM assigned", !!pm], ["Timeline set", !!(p.startDate && p.deadline)], ["Known status", !!p.knownStatus], ["Linked IDs", (p.linkedIds || []).length > 0]]
    : [["Project ID", !!p.projectId], ["Customer LLD", !!p.lldCustomer], ["Designer LLD", !!p.lldDesigner], ["PM assigned", !!pm], ["Deadline set", !!p.deadline]];
  const analyseDrive = async () => {
    setIntelBusy(true);
    const { digest, error: driveErr } = await driveReadDigest(p.projectId, p.linkedIds, { scope: driveScope(my?.role) });
    if (driveErr) toast(driveErr, "amber");
    try {
      const txt = await claude(driveIntelPrompt(p, users, memory, digest), { json: false });
      setIntel(txt); upd({ driveAnalysis: { text: txt, at: new Date().toISOString(), live: !!digest } });
      if (digest) toast("Analysed with live Drive contents", "green");
      // Push the analysis back into the project folder so the team sees it in Drive.
      const wrote = await driveWriteFile(p.projectId, `${todayStr()}_AI-status-analysis.txt`, `Elecbits ODM — AI status analysis\nProject ${p.projectId} · ${p.name || ""}\nGenerated ${new Date().toISOString()}\n\n${txt}\n`);
      if (wrote === true) sheetSync(`${pmPath(p.projectId)}`, `AI status analysis written to Drive`);
    }
    catch { setIntel(fallbackIntel(p)); toast("AI offline — showing what we have", "amber"); }
    setIntelBusy(false);
  };
  const addIntel = async () => {
    const raw = noteVal.trim(); if (!raw) return;
    setNoteBusy(true);
    let organised = raw;
    // Keep the raw note whenever the AI can't tidy it — never store a blank.
    try { const t = await claude(intelOrgPrompt(p, raw, memory), { json: false }); if (t && t.trim()) organised = t.trim(); } catch { }
    const entry = { id: uid(), at: new Date().toISOString(), by: me, text: organised || raw, raw };
    upd({ intelligence: [entry, ...(p.intelligence || [])] });
    setNoteVal(""); setNoteBusy(false);
    toast("Intelligence added", "green");
  };
  const slotUser = (slot) => teamDraft.find((t) => t.slot === slot)?.userId || "";
  const setSlot = (slot, userId) => setTeamDraft((td) => { const rest = td.filter((t) => t.slot !== slot); return userId ? [...rest, { slot, userId }] : rest; });
  const saveTeam = () => { upd({ team: teamDraft.filter((t) => t.userId) }); setEditTeam(false); toast("Team updated", "green"); };
  /* Put every to-do under the stage it belongs to. The keyword pass files the
     obvious ones on the spot; the AI does the rest, because most of the
     judgement is about what the work IS rather than what it is called — a
     customer quote is design-stage work however it is worded. Runs by itself
     whenever the plan is built or rebuilt, so no project is ever left flat. */
  const fileTodos = async (stagesIn, { announce = true } = {}) => {
    const st = stagesIn || pRef.current.plan?.stages || [];
    if (!st.length) { if (announce) toast("Build the plan first — to-dos are filed under its stages", "amber"); return; }
    const mine = tasks.filter((t) => t.projectId === p.projectId)
      .map((t) => ({ ...t, assigneeName: users.find((u) => u.id === t.assigneeId)?.name || "" }));
    const loose = needsFiling(st, mine);
    if (!loose.length) { if (announce) toast("Every to-do is already under a stage", "green"); return; }

    setFiling(true);
    const filed = new Map(withStages(st, loose).filter((t) => t.stageId).map((t) => [t.id, t.stageId]));
    try {
      const r = await claude(groupPrompt(p, st, loose), { maxTokens: 3000 });
      for (const f of r?.filed || []) {
        const s = st.find((x) => x.id === f.stage || normId(x.name) === normId(f.stage));
        if (s && loose.some((t) => t.id === f.task)) filed.set(f.task, s.id);
      }
    } catch { /* the keyword pass stands on its own */ }
    setFiling(false);

    if (!filed.size) { if (announce) toast("Couldn't work out where those to-dos belong — file them by hand", "amber"); return; }
    setTasks((ts) => ts.map((t) => (filed.has(t.id) ? { ...t, stageId: filed.get(t.id) } : t)));
    if (announce) toast(`${filed.size} to-do${filed.size === 1 ? "" : "s"} filed under the plan`, "green");
  };
  const moveTodo = (taskId, stageId) => setTasks((ts) => ts.map((t) => (t.id === taskId ? { ...t, stageId } : t)));

  /* Build (or rebuild) the plan from the project's real Drive contents. */
  const buildPlan = async () => {
    if (planBusy) return;
    setPlanBusy(true);
    try {
      const { digest, error } = await driveReadDigest(p.projectId, p.linkedIds, { scope: driveScope(my?.role), search: "checklist tracker plan schedule milestones review" });
      let built = null;
      try {
        const r = await claude(planBuildPrompt(p, projTasks, users, memory, digest), { maxTokens: 6000 });
        built = Array.isArray(r?.stages) && r.stages.length ? r : null;
      } catch { built = null; }

      // An existing plan carries things that live nowhere else — dates the PM
      // shifted after a vendor call, notes, owners. Never trade that for the
      // generic skeleton because the AI happened to be unreachable.
      if (!built) {
        if (p.plan?.stages?.length) {
          toast(error || "Couldn't reach the AI — the plan is untouched. Try again in a moment.", "amber");
          return;
        }
        built = fallbackPlan(p);
        if (!built) { toast("Couldn't build a plan — check the project's start and deadline dates.", "amber"); return; }
        const outlineEntry = { id: uid(), at: new Date().toISOString(), byName: my?.name || "someone", why: "Created an outline plan", what: `${built.stages.length} stages · the AI was unreachable, so this is a template to refresh later` };
        upd((cur) => ({ plan: { ...built, updatedAt: outlineEntry.at, log: [outlineEntry, ...(cur.plan?.log || [])].slice(0, 100) } }));
        toast(error || "Outline plan created — refresh it when the AI is back", "amber");
        return;
      }

      const entry = {
        id: uid(), at: new Date().toISOString(), byName: my?.name || "someone",
        why: pRef.current.plan?.stages?.length ? "Refreshed the plan from Drive" : "Built the plan from Drive",
        what: `${built.stages.length} stages${digest ? " · read from the project's files" : " · from the project's tasks and status, Drive was quiet"}`,
      };
      upd((cur) => ({ plan: { ...built, updatedAt: entry.at, log: [entry, ...(cur.plan?.log || [])].slice(0, 100) } }));
      toast(digest ? "Plan built from the project's files" : "Plan built — Drive had nothing to add", digest ? "green" : "amber");
      await fileTodos(built.stages, { announce: false });
    } finally {
      setPlanBusy(false);
    }
  };

  /* Build the plan from a checklist they uploaded — their sheet, their order,
     their parallelism. Also filed into the project's Drive folder. */
  const planFromSheet = async (file) => {
    if (planBusy) return;
    setPlanBusy(true);
    try { await planFromSheetInner(file); } finally { setPlanBusy(false); }
  };
  const planFromSheetInner = async (file) => {
    let text = "";
    try { text = await sheetToText(file); } catch { text = ""; }
    if (!text.trim()) {
      toast(`Couldn't read ${file.name} — save it as .xlsx or .csv and try again`, "amber");
      return;
    }
    let built = null;
    try {
      const r = await claude(planFromSheetPrompt(p, users, file.name, text), { maxTokens: 6000 });
      built = Array.isArray(r?.stages) && r.stages.length ? r : null;
    } catch { built = null; }
    if (!built) {
      toast("The AI couldn't turn that sheet into a plan — is it reachable?", "amber");
      return;
    }
    const entry = {
      id: uid(), at: new Date().toISOString(), byName: my?.name || "someone",
      why: `Built the plan from the uploaded checklist ${file.name}`,
      what: `${built.stages.length} stages across ${new Set(built.stages.map((s) => s.track || "Plan")).size} workstream(s)`,
    };
    upd((cur) => ({ plan: { ...built, source: file.name, updatedAt: entry.at, log: [entry, ...(cur.plan?.log || [])].slice(0, 100) } }));
    toast(`Plan built from ${file.name}`, "green");
    await fileTodos(built.stages, { announce: false });
    // Keep their checklist with the project, so the next Drive read sees it too.
    const att = await readAttachment(file);
    if (!att.tooBig && !att.failed) {
      const r = await saveAttachmentToDrive(att, p.projectId, driveScope(my?.role));
      if (r === true) sheetSync(`${pmPath(p.projectId)}`, `${file.name} uploaded with the plan`);
    }
  };

  /* Write up a brainstorm: the AI pulls out the challenges, whose ideas
     helped, the decisions, the actions and the lessons — then the actions
     become tasks, the lessons become memory, and the note goes to Drive. */
  const saveMom = async () => {
    const raw = momVal.trim();
    if (!raw || momBusy) return;
    setMomBusy(true);
    try {
      let ai = null;
      try { ai = await claude(momPrompt(p, raw, momWho.trim(), users, memory), { maxTokens: 4000 }); } catch { ai = null; }
      // Credit is only worth keeping if it points at a real person. The AI
      // writes whatever name was said in the room ("Neha", "neha r"), so pin
      // each one to the roster — that is what links an idea to its author's
      // Performance page and keeps the leaderboard from splitting one person
      // across three spellings.
      if (ai?.ideas) ai.ideas = ai.ideas.map((i) => ({ ...i, by: findPerson(users, i.by)?.name || String(i.by || "").trim() }));
      if (ai?.decisions) ai.decisions = ai.decisions.map((d) => ({ ...d, owner: findPerson(users, d.owner)?.name || d.owner || "" }));
      const at = new Date().toISOString();
      const entry = {
        id: uid(), date: todayStr(), time: nowHM(), by: me, byName: my?.name || "someone",
        attendees: momWho.trim(), raw, ai: ai || null, at,
        title: ai?.title || raw.split("\n")[0].slice(0, 60),
      };

      // Actions become real tasks for real people.
      const raised = [];
      for (const a of (ai?.actions || []).slice(0, 10)) {
        if (!a.title) continue;
        const u = findPerson(users, a.assignee);
        raised.push({
          id: uid(), projectId: p.projectId, linked: true, title: a.title, assigneeId: u?.id || "",
          date: a.due || todayStr(), startTime: nowHM(),
          endTime: new Date(Date.now() + 60 * 60000).toTimeString().slice(0, 5),
          steps: [], conditions: [], status: "pending", origin: "mom", momId: entry.id, createdBy: me, createdAt: at, work: {},
          stageId: guessStageId(pRef.current.plan?.stages || [], { title: a.title, date: a.due || todayStr() }),
        });
      }
      if (raised.length) setTasks((ts) => [...raised, ...ts]);

      // Lessons become memory, so the next project inherits them.
      const lessons = (ai?.lessons || []).filter(Boolean).slice(0, 6);
      if (lessons.length) {
        setMemory((mm) => [{
          id: uid(), type: "instruction",
          title: `Lessons — ${entry.title}`,
          content: `From the ${fmtDate(entry.date)} discussion on ${p.projectId}:\n${lessons.map((l) => `- ${l}`).join("\n")}`,
          createdAt: at,
        }, ...mm]);
      }

      // And the write-up itself into the project's Internal MoM folder.
      const fileName = `Internal MoM - ${entry.date} - ${String(entry.title).replace(/[^\w\- ]/g, "").trim().slice(0, 50) || "discussion"}.md`;
      const body = [
        `# ${entry.title}`, ``, `${p.projectId} · ${fmtDate(entry.date)} ${entry.time} · written up by ${entry.byName}`,
        entry.attendees ? `In the room: ${entry.attendees}` : "", ``,
        ai?.summary ? `${ai.summary}\n` : "",
        (ai?.challenges || []).length ? `## Challenges\n${ai.challenges.map((c) => `- ${c.problem}\n  ${c.status === "solved" ? "Overcome" : c.status === "open" ? "Still open" : "Watching"}: ${c.solution || "—"}`).join("\n")}\n` : "",
        (ai?.ideas || []).length ? `## Who moved it forward\n${ai.ideas.map((i) => `- ${i.by}: ${i.idea} (${impactOf(i.impact).label}, ${i.value}/5)${i.why ? ` — ${i.why}` : ""}`).join("\n")}\n` : "",
        (ai?.decisions || []).length ? `## Decided\n${ai.decisions.map((d) => `- ${d.what}${d.owner ? ` — ${d.owner}` : ""}`).join("\n")}\n` : "",
        (ai?.actions || []).length ? `## Actions\n${ai.actions.map((a) => `- ${a.title} — ${a.assignee || "unassigned"}${a.due ? ` by ${a.due}` : ""}`).join("\n")}\n` : "",
        lessons.length ? `## Lessons\n${lessons.map((l) => `- ${l}`).join("\n")}\n` : "",
        `## Notes as written\n${raw}`,
      ].filter(Boolean).join("\n");
      const r = await driveWriteFile(p.projectId, fileName, body, { scope: driveScope(my?.role) });
      if (r === true) { entry.savedTo = p.projectId; sheetSync(`${pmPath(p.projectId)}`, `${fileName} filed from Internal MoM`); }

      upd((cur) => ({ moms: [entry, ...(cur.moms || [])] }));
      setMomVal(""); setMomWho("");
      const bits = [];
      if (raised.length) bits.push(`${raised.length} task${raised.length === 1 ? "" : "s"} raised`);
      if (lessons.length) bits.push(`${lessons.length} lesson${lessons.length === 1 ? "" : "s"} remembered`);
      if (r === true) bits.push("filed in Drive");
      toast(ai ? `Written up${bits.length ? ` — ${bits.join(", ")}` : ""}` : "Saved — the AI was unreachable, so it's kept as written", ai ? "green" : "amber");
      if (r !== true && DRIVE_READ_URL) toast(tidyReason(r), "amber");
    } finally {
      setMomBusy(false);
    }
  };

  const sendChat = async () => {
    const q = chatVal.trim();
    if ((!q && !chatAtts.length) || chatBusy) return;
    const hist = p.chat || [];
    const sent = chatAtts;
    if (sent.length) chatLastAtts.current = sent;
    // Files stay in hand for later turns, so "actually, keep that one" works.
    const pool = sent.length ? sent : chatLastAtts.current;
    const mine = { id: uid(), who: "me", text: q || `Sent ${sent.map((a) => a.name).join(", ")}`, by: me, at: new Date().toISOString(), files: sent.length ? sent.map((a) => ({ name: a.name, size: a.size })) : undefined };
    upd({ chat: [...hist, mine] });
    setChatVal(""); setChatAtts([]); setChatBusy(true);
    let reply;
    // Pull live Drive contents so the copilot answers from real files rather
    // than telling the PM to go and paste them in.
    const { digest: chatDigest } = await driveReadDigest(p.projectId, p.linkedIds, { scope: driveScope(my?.role), search: q });
    const ask = (driveData) => claude(projChatPrompt(p, projTasks, users, hist, q, memory, driveData, pool, sent.length > 0), { json: false, images: imageBlocks(pool), web: true });
    try {
      reply = await ask(chatDigest);
      // <<<LOOK term>>> — it decided the first read didn't cover the question.
      // Fetch exactly what it asked for and let it finish, in the same turn.
      const look = String(reply).match(/<<<LOOK\s+([^>\n]+?)\s*>>>/);
      if (look) {
        const { digest: again } = await driveReadDigest(p.projectId, p.linkedIds, { scope: driveScope(my?.role), search: look[1] });
        if (again) {
          const second = await ask(`${again}${chatDigest ? `\n\n(also read a moment ago)\n${chatDigest.slice(0, 6000)}` : ""}`);
          reply = String(second).replace(/<<<LOOK[^>]*>>>/g, "").trim() || second;
        } else {
          reply = String(reply).replace(/<<<LOOK[^>]*>>>/g, "").trim();
        }
      }
    } catch {
      const open = projTasks.filter((t) => t.status !== "done");
      reply = `AI is unreachable, so here's the data directly: ${p.projectId} is ${p.status}, deadline ${fmtDate(p.deadline)}, ${done.length}/${projTasks.length} tasks done.${open.length ? ` Open: ${open.slice(0, 5).map((t) => t.title).join("; ")}${open.length > 5 ? "…" : ""}.` : ""} Known status: ${p.knownStatus ? p.knownStatus.slice(0, 200) : "not written yet"}.`;
    }
    // The assistant can create files with <<<WRITE name>>> … <<<END>>> and keep
    // an attached file with <<<SAVE name>>>. Execute both here; created files
    // also become document cards on the reply.
    const writes = [...String(reply).matchAll(/<<<WRITE\s+([^>\n]+?)\s*>>>\s*([\s\S]*?)\s*<<<END>>>/g)];
    const planBlock = String(reply).match(/<<<PLAN>>>\s*([\s\S]*?)\s*<<<END>>>/);
    const saves = [...String(reply).replace(/<<<PLAN>>>[\s\S]*?<<<END>>>/g, "").matchAll(/<<<SAVE\s+([^>\n]+?)\s*>>>/g)];
    let clean = String(reply)
      .replace(/<<<PLAN>>>[\s\S]*?<<<END>>>/g, "")
      .replace(/<<<WRITE[\s\S]*?<<<END>>>/g, "")
      .replace(/<<<SAVE[^>]*>>>/g, "").trim();
    const results = []; const docs = [];

    // A plan change the AI worked out from what they just said — apply it,
    // raise any tasks that come with it, and record who and when.
    if (planBlock) {
      let patch = null;
      try { patch = JSON.parse(planBlock[1]); } catch { /* malformed — ignore */ }
      if (patch && (patch.changes?.length || patch.tasks?.length)) {
        // What the stage list will look like once this patch lands, worked out
        // here so any task the same patch raises can be filed under a stage
        // the patch itself added.
        const nextStages = patch.changes?.length ? planPatchResult(pRef.current.plan, patch).stages : (pRef.current.plan?.stages || []);
        if (patch.changes?.length) {
          const { touched } = planPatchResult(pRef.current.plan, patch);
          const entry = {
            id: uid(), at: new Date().toISOString(), byName: my?.name || "someone",
            why: String(patch.reason || "").slice(0, 400),
            what: touched.join(" · ").slice(0, 600) || "no stage changed",
          };
          upd((cur) => {
            const r = planPatchResult(cur.plan, patch);
            return { plan: { ...(cur.plan || {}), stages: r.stages, summary: patch.summary || cur.plan?.summary || "", updatedAt: entry.at, log: [entry, ...(cur.plan?.log || [])].slice(0, 100) } };
          });
          results.push(`Plan updated — ${touched.join(" · ")}. Logged against your name.`);
          sheetSync(`${pmPath(p.projectId)}`, `Plan updated from project chat: ${patch.reason || "change"}`);
        }
        const raised = [];
        for (const t of (patch.tasks || []).slice(0, 8)) {
          if (!t.title) continue;
          const u = findPerson(users, t.assignee);
          raised.push({
            id: uid(), projectId: p.projectId, linked: true, title: t.title, assigneeId: u?.id || "",
            date: t.date || todayStr(), startTime: t.startTime || nowHM(),
            endTime: t.endTime || new Date(Date.now() + 60 * 60000).toTimeString().slice(0, 5),
            steps: [], conditions: [], status: "pending", origin: "plan", createdBy: me, createdAt: new Date().toISOString(), work: {},
            stageId: (nextStages.find((s) => s.id === t.stage || normId(s.name) === normId(t.stage))?.id)
              || guessStageId(nextStages, { title: t.title, date: t.date || todayStr() }),
          });
        }
        if (raised.length) {
          setTasks((ts) => [...raised, ...ts]);
          results.push(`${raised.length} new task${raised.length === 1 ? "" : "s"}: ${raised.map((t) => t.title).join("; ")}.`);
        }
        if (patch.changes?.length || raised.length) toast("Plan and tasks updated", "green");
      }
    }
    for (const [, rawName, content] of writes) {
      const fileName = rawName.trim().replace(/[\\/:*?"<>|]/g, "-");
      const r = await driveWriteFile(p.projectId, fileName, content, { scope: driveScope(my?.role) });
      results.push(saveResult(r, fileName, p.projectId));
      docs.push({ title: fileName, fileName, content: String(content).slice(0, 12000), savedTo: r === true ? p.projectId : "" });
      if (r === true) sheetSync(`${pmPath(p.projectId)}`, `${fileName} written from project chat`);
    }
    for (const [, rawName] of saves) {
      const want = normId(rawName);
      // Only fall back to "the one file in hand" when there is genuinely only
      // one — guessing between several would file the wrong document.
      const f = pool.find((x) => normId(x.name) === want)
        || pool.find((x) => normId(x.name).includes(want) || want.includes(normId(x.name)))
        || (pool.length === 1 ? pool[0] : null);
      if (!f) { results.push(`I'm not sure which file you meant — attach it again and I'll keep it.`); continue; }
      if (f.tooBig || f.failed) { results.push(`Couldn't save ${f.name} — attach it again and I'll keep it.`); continue; }
      const r = await saveAttachmentToDrive(f, p.projectId, driveScope(my?.role));
      results.push(saveResult(r, f.name, p.projectId));
      if (r === true) sheetSync(`${pmPath(p.projectId)}`, `${f.name} uploaded from project chat`);
    }
    if (results.length) {
      clean = [clean, results.join("\n")].filter(Boolean).join("\n\n");
      if (results.some((r) => r.startsWith("Saved"))) toast("Saved to Drive", "green");
    }
    upd({ chat: [...hist, mine, { id: uid(), who: "ai", text: clean || String(reply), docs: docs.length ? docs : undefined, at: new Date().toISOString() }] });
    setChatBusy(false);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* header */}
      <div className="card" style={{ padding: "14px 18px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <button onClick={onBack} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--txt2)", display: "flex", alignItems: "center", gap: 5, padding: 0, fontSize: 12.5, fontWeight: 600 }}><ArrowRight size={15} style={{ transform: "rotate(180deg)" }} /> Projects</button>
          <span style={{ color: "var(--bdr2)" }}>/</span>
          <span style={{ fontFamily: MONO, fontWeight: 600, fontSize: 13, color: "var(--acc)" }}>{p.projectId}</span>
          <span style={{ fontWeight: 800, fontSize: 15 }}>{p.name}</span>
          {sanctioned ? <Pill color="var(--green)"><CheckCircle2 size={11} /> Sanctioned</Pill> : <Pill color="var(--amber)">Planning</Pill>}
          <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
            <Pill color={dl < 0 ? "var(--red)" : dl <= 7 ? "var(--amber)" : "var(--txt2)"}><Calendar size={11} /> {fmtDate(p.deadline)} · {dl < 0 ? `${-dl}d over` : `${dl}d left`}</Pill>
            {isAdmin ? (
              <select className="inp" style={{ width: 150, padding: "6px 10px", fontWeight: 600, color: statColor(p.status) }} value={p.status} onChange={(e) => setStatus(p.id, e.target.value)}>
                {STATUSES.map((s) => <option key={s.k} value={s.k}>{s.k}</option>)}
              </select>
            ) : <Pill color={statColor(p.status)}>{p.status}</Pill>}
            {isAdmin && !confirmDel && <Btn small kind="ghost" icon={Trash2} style={{ color: "var(--red)", borderColor: "color-mix(in srgb, var(--red) 40%, transparent)" }} onClick={() => setConfirmDel(true)}>Delete</Btn>}
          </div>
        </div>
        {confirmDel && (
          <div className="fade" style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", padding: "10px 13px", borderRadius: 10, border: "1px solid var(--red)", background: "color-mix(in srgb, var(--red) 8%, transparent)" }}>
            <AlertTriangle size={15} style={{ color: "var(--red)", flexShrink: 0 }} />
            <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--red)", flex: 1, minWidth: 220 }}>
              Delete "{p.name}" permanently? This also removes its {projTasksCount(tasks, p.projectId)} task(s), known status and intelligence log. This cannot be undone.
            </span>
            <Btn small kind="danger" icon={Trash2} onClick={() => {
              const n = projTasksCount(tasks, p.projectId);
              setTasks((ts) => ts.filter((t) => t.projectId !== p.projectId));
              setProjects((ps) => ps.filter((x) => x.id !== p.id));
              sheetSync("Project Data and IDs (Google Sheet)", `${p.projectId} deleted (${n} task(s) removed)`);
              toast(`Project ${p.projectId} deleted`, "amber");
              onBack();
            }}>Yes — delete project</Btn>
            <Btn small kind="ghost" onClick={() => setConfirmDel(false)}>Cancel</Btn>
          </div>
        )}
      </div>

      {/* One page per job. Everything used to stack into one long scroll and
          compete for the same attention; each of these is now the only thing
          on screen when you are actually doing it. */}
      <div className="card" style={{ padding: "0 14px", display: "flex", alignItems: "center", gap: 2, flexWrap: "wrap", overflowX: "auto" }}>
        {PROJ_TABS.map(([k, label, Ic, badge]) => {
          const n = badge === "tasks" ? openTasks.length : badge === "mom" ? (p.moms || []).length : badge === "plan" ? (p.plan?.stages || []).length : 0;
          return (
            <button key={k} data-ptab={k} onClick={() => setTab(k)}
              style={{ display: "flex", alignItems: "center", gap: 7, padding: "12px 14px", background: "none", border: "none", borderBottom: `2px solid ${tab === k ? "var(--acc)" : "transparent"}`, color: tab === k ? "var(--acc)" : "var(--txt2)", fontWeight: tab === k ? 700 : 600, fontSize: 13, cursor: "pointer", whiteSpace: "nowrap", transition: "all .15s" }}>
              <Ic size={15} /> {label}
              {n > 0 && <span style={{ fontSize: 10.5, fontWeight: 700, padding: "1px 6px", borderRadius: 99, background: tab === k ? "var(--soft)" : "var(--s2)", color: tab === k ? "var(--acc)" : "var(--txt3)" }}>{n}</span>}
            </button>
          );
        })}
      </div>

      {/* overall progress */}
      {tab === "overview" && (
      <Section>
        <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
          <div style={{ minWidth: 90 }}>
            <div style={{ fontSize: 34, fontWeight: 800, fontFamily: MONO, color: pct === 100 ? "var(--green)" : "var(--acc)", lineHeight: 1 }}>{pct}%</div>
            <div style={{ fontSize: 11, color: "var(--txt2)", marginTop: 3 }}>{done.length}/{projTasks.length} tasks done</div>
          </div>
          <div style={{ flex: 1, minWidth: 220 }}>
            <div style={{ display: "flex", marginBottom: 8 }}><Progress pct={pct} color={pct === 100 ? "var(--green)" : "var(--acc)"} h={10} /></div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {counts.map(([label, n, c]) => <Pill key={label} color={c}>{label} {n}</Pill>)}
            </div>
          </div>
        </div>
      </Section>
      )}

      <div style={{ display: "grid", gridTemplateColumns: tab === "overview" ? "minmax(0,1fr) minmax(0,340px)" : "minmax(0,1fr)", gap: 16, alignItems: "start" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {(tab === "overview" || tab === "tasks") && (
          <Section>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: "var(--txt)", textTransform: "uppercase", letterSpacing: ".06em" }}>{tab === "tasks" ? "Every open to-do" : "Next to-dos"}</span>
              {todos.length > 0 && <Pill color="var(--purple)">{todos.length} open</Pill>}
              {tab === "tasks" && planStages.length > 0 && (
                <span style={{ marginLeft: "auto", display: "flex", gap: 7, alignItems: "center", flexWrap: "wrap" }}>
                  <button onClick={() => setGrouped((g) => !g)} style={{ background: "none", border: "none", color: "var(--acc)", cursor: "pointer", fontSize: 12, fontWeight: 600 }}>{grouped ? "Show as a flat list" : "Group under the plan"}</button>
                  {grouped && unfiled.length > 0 && <Btn small kind="ghost" icon={filing ? Loader2 : Sparkles} disabled={filing} onClick={() => fileTodos()}>{filing ? "Filing…" : `File the ${unfiled.length} loose`}</Btn>}
                </span>
              )}
              {(tab !== "tasks" || !planStages.length) && <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--txt3)" }}>from Daily Scrum</span>}
            </div>
            {todos.length === 0 ? (
              <Empty icon={ListChecks} title="No open to-dos" sub="Every open task for this project shows here, most urgent first. Add them in Daily Scrum — organise a note and push the tasks." />
            ) : tab === "tasks" && grouped && planStages.length > 0 ? (
              /* Nested under the plan: a stage, then the work that belongs to
                 it. Click a stage to open or shut it. */
              <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                {groupTasksByStage(planStages, todos).map(([stage, list]) => {
                  const key = stage?.id || "__loose__";
                  const shut = closedStages.includes(key);
                  return (
                    <div key={key} style={{ border: "1px solid var(--bdr)", borderRadius: 11, background: "var(--s1)", overflow: "hidden" }}>
                      <button onClick={() => setClosedStages((c) => (c.includes(key) ? c.filter((x) => x !== key) : [...c, key]))}
                        style={{ display: "flex", alignItems: "center", gap: 9, width: "100%", padding: "10px 13px", background: "none", border: "none", borderBottom: shut || !list.length ? "none" : "1px solid var(--bdr)", cursor: "pointer", textAlign: "left" }}>
                        <ChevronDown size={14} style={{ color: "var(--txt3)", flexShrink: 0, transform: shut ? "rotate(-90deg)" : "none", transition: "transform .15s" }} />
                        <span style={{ width: 8, height: 8, borderRadius: "50%", background: stage ? planColor(stage.status) : "var(--amber)", flexShrink: 0 }} />
                        <span style={{ fontWeight: 700, fontSize: 13, flex: 1, minWidth: 0 }}>{stage ? stage.name : "Not filed under a stage yet"}</span>
                        {stage?.track && <span style={{ fontSize: 10.5, color: "var(--txt3)" }}>{stage.track}</span>}
                        <Pill color={list.length ? "var(--purple)" : "var(--txt3)"}>{list.length} open</Pill>
                        {stage && <Pill color={planColor(stage.status)}>{planLabel(stage.status)}</Pill>}
                      </button>
                      {!shut && list.length > 0 && (
                        <div className="fade" style={{ display: "flex", flexDirection: "column", gap: 7, padding: 11 }}>
                          {list.map((t) => (
                            <TodoCard key={t.id} t={t} users={users} stages={planStages} onMove={moveTodo} nowMs={nowMs} />
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {(tab === "tasks" ? todos : todos.slice(0, 5)).map((t) => <TodoCard key={t.id} t={t} users={users} nowMs={nowMs} />)}
                {tab === "overview" && todos.length > 5 && (
                  <button onClick={() => setTab("tasks")} style={{ alignSelf: "flex-start", background: "none", border: "none", color: "var(--acc)", cursor: "pointer", fontSize: 12, fontWeight: 600, padding: "4px 2px" }}>
                    See all {todos.length} to-dos →
                  </button>
                )}
              </div>
            )}
          </Section>
          )}

          {/* a glance at the plan from the overview, without the whole board */}
          {tab === "overview" && (p.plan?.stages || []).length > 0 && (
            <Section>
              <CardLabel right={<button onClick={() => setTab("plan")} style={{ background: "none", border: "none", color: "var(--acc)", cursor: "pointer", fontSize: 12, fontWeight: 600 }}>Open the plan →</button>}>Where the plan stands</CardLabel>
              {(() => {
                const st = p.plan.stages;
                const doneN = st.filter((x) => x.status === "done").length;
                const now = st.filter((x) => x.status === "active" || x.status === "blocked");
                return (<>
                  <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: now.length ? 11 : 0 }}>
                    <span style={{ fontSize: 22, fontWeight: 800, fontFamily: MONO, color: "var(--acc)" }}>{doneN}/{st.length}</span>
                    <span style={{ flex: 1 }}><Progress pct={(doneN / st.length) * 100} color="var(--acc)" h={8} /></span>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    {now.slice(0, 4).map((x) => (
                      <div key={x.id} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5 }}>
                        <span style={{ width: 8, height: 8, borderRadius: "50%", background: planColor(x.status), flexShrink: 0 }} />
                        <span style={{ flex: 1, minWidth: 0 }}>{x.name}</span>
                        {x.track && <span style={{ fontSize: 10.5, color: "var(--txt3)" }}>{x.track}</span>}
                        <Pill color={planColor(x.status)}>{planLabel(x.status)}</Pill>
                      </div>
                    ))}
                    {!now.length && <div style={{ fontSize: 12.5, color: "var(--txt2)" }}>Nothing marked in progress right now.</div>}
                  </div>
                </>);
              })()}
            </Section>
          )}

          {tab === "plan" && <PlanBoard p={p} upd={upd} projTasks={projTasks} users={users} busy={planBusy} onBuild={buildPlan} onSheet={planFromSheet} onFile={fileTodos} filing={filing} myName={my?.name} />}

          {tab === "mom" && (
          <Section>
            <CardLabel right={<Pill color="var(--purple)"><Lightbulb size={11} /> ideas · challenges · lessons</Pill>}>Brainstorming session</CardLabel>
            <div style={{ fontSize: 12, color: "var(--txt2)", lineHeight: 1.6, marginBottom: 10 }}>
              Type up what was discussed — a design argument, a supplier problem, a review that went badly. The AI pulls out what the challenge really was and how it was beaten, whose idea helped, what was decided, and what has to happen next. Actions become tasks, lessons go into system memory so the next project inherits them, and the write-up is filed in this project's folder.
            </div>
            <input className="inp" style={{ marginBottom: 8 }} placeholder="Who was in the room? (optional)" value={momWho} onChange={(e) => setMomWho(e.target.value)} />
            <textarea className="inp" rows={5} placeholder="Ravi said the connector lead time is 6 weeks so the BoM freeze slips. Neha suggested the alternate from the approved list — same footprint, in stock. We agreed to switch and to check lead times before every freeze from now on…" value={momVal} onChange={(e) => setMomVal(e.target.value)} />
            <div style={{ display: "flex", gap: 9, marginTop: 9, alignItems: "center", flexWrap: "wrap" }}>
              <Btn small icon={momBusy ? Loader2 : Sparkles} disabled={momBusy || !momVal.trim()} onClick={saveMom}>{momBusy ? "Writing it up…" : "Save and write it up"}</Btn>
              <span style={{ fontSize: 11, color: "var(--txt3)" }}>{(p.moms || []).length} session{(p.moms || []).length === 1 ? "" : "s"} kept on this project</span>
            </div>
            {(p.moms || []).length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 9, marginTop: 13 }}>
                {(p.moms || []).slice(0, 4).map((m) => <MomCard key={m.id} m={m} />)}
                {(p.moms || []).length > 4 && <div style={{ fontSize: 11.5, color: "var(--txt3)" }}>Older sessions are on the Brainstorming Sessions page.</div>}
              </div>
            )}
          </Section>
          )}

          {tab === "overview" && (p.knownStatus || isPM) && (
            <Section>
              <CardLabel right={isPM && <button onClick={() => { if (!editStatus) setStatusDraft(p.knownStatus || ""); setEditStatus(!editStatus); }} style={{ background: "none", border: "none", color: "var(--acc)", cursor: "pointer", fontSize: 12, fontWeight: 600 }}>{editStatus ? "Cancel" : "Edit"}</button>}>Known status</CardLabel>
              {editStatus ? (
                <div>
                  <textarea className="inp" rows={4} value={statusDraft} onChange={(e) => setStatusDraft(e.target.value)} placeholder="Where the project stands right now…" />
                  <div style={{ marginTop: 8 }}><Btn small kind="green" icon={CheckCircle2} onClick={() => { upd({ knownStatus: statusDraft.trim() }); setEditStatus(false); toast("Status updated", "green"); }}>Save status</Btn></div>
                </div>
              ) : (
                <div style={{ fontSize: 12.5, color: p.knownStatus ? "var(--txt)" : "var(--txt2)", whiteSpace: "pre-wrap", lineHeight: 1.6 }}>{p.knownStatus || "No known status written yet — add it, or drop a manual-intelligence note below."}</div>
              )}
            </Section>
          )}

          {tab === "files" && (
          <Section>
            <CardLabel right={<Pill color="var(--purple)"><Database size={11} /> PM + PCB folders</Pill>}>Drive intelligence</CardLabel>
            <div style={{ fontFamily: MONO, fontSize: 10.5, color: "var(--txt3)", marginBottom: 4 }}>{pmPath(p.projectId)} → Checklist.xlsx · Reports/ · Client-Comms/</div>
            {(p.linkedIds || []).length > 0 && <div style={{ fontFamily: MONO, fontSize: 10.5, color: "var(--txt3)", marginBottom: 10 }}>{p.linkedIds.map((x) => `${pcbPath(x)}`).join("   ")}</div>}
            <div style={{ fontSize: 11.5, color: "var(--txt2)", marginBottom: 10, lineHeight: 1.5 }}>The OS reads these folders and tells you what's going on. Live Drive read is the integration seam; the analysis uses the folder map, the known status and the intelligence log below.</div>
            <Btn small icon={intelBusy ? Loader2 : Sparkles} disabled={intelBusy} onClick={analyseDrive}>{intelBusy ? "Analysing…" : intel ? "Re-analyse how it's moving" : "Analyse how things are moving"}</Btn>
            {intel && <div style={{ marginTop: 12, padding: 12, background: "var(--s2)", border: "1px solid var(--bdr)", borderRadius: 10, fontSize: 12.5, whiteSpace: "pre-wrap", lineHeight: 1.6, color: "var(--txt)" }}>{intel}{p.driveAnalysis?.at && <div style={{ fontSize: 10, color: "var(--txt3)", marginTop: 8 }}>analysed {fmtDate(p.driveAnalysis.at.slice(0, 10))}</div>}</div>}
            <div style={{ marginTop: 14, borderTop: "1px dashed var(--bdr2)", paddingTop: 12 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: "var(--txt2)", textTransform: "uppercase", letterSpacing: ".05em", marginBottom: 8 }}>Manual intelligence</div>
              <div style={{ display: "flex", gap: 8 }}>
                <textarea className="inp" rows={2} style={{ flex: 1, resize: "vertical" }} value={noteVal} onChange={(e) => setNoteVal(e.target.value)} placeholder="Add what you know — the AI organises it into the project's status memory…" />
                <Btn small title="Add intelligence" icon={noteBusy ? Loader2 : Send} disabled={noteBusy || !noteVal.trim()} onClick={addIntel} style={{ alignSelf: "flex-start", width: 40, padding: 0 }}> </Btn>
              </div>
              {(p.intelligence || []).length > 0 && (
                <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
                  {(p.intelligence || []).map((e) => {
                    const u = users.find((x) => x.id === e.by);
                    return (
                      <div key={e.id} style={{ padding: "9px 11px", background: "var(--s1)", border: "1px solid var(--bdr)", borderRadius: 9 }}>
                        <div style={{ fontSize: 12.5, color: "var(--txt)", lineHeight: 1.5 }}>{e.text}</div>
                        <div style={{ fontSize: 10, color: "var(--txt3)", marginTop: 4 }}>{u?.name || "—"} · {fmtDate((e.at || "").slice(0, 10))}</div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </Section>

          )}

          {tab === "chat" && (
          <Section>
            <CardLabel right={<Pill color="var(--acc)"><Bot size={11} /> knows tasks · status · Drive · memory</Pill>}>Project chat — ask the AI</CardLabel>
            <div ref={chatRef} style={{ maxHeight: 330, overflowY: "auto", display: "flex", flexDirection: "column", gap: 9, marginBottom: 11, paddingRight: 4 }}>
              {(p.chat || []).length === 0 && !chatBusy && (
                <div style={{ fontSize: 12, color: "var(--txt2)", lineHeight: 1.7, padding: "6px 2px" }}>
                  Ask anything about this project — the copilot answers from its tasks, team, known status, Drive folders and system memory. Try:
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 7 }}>
                    {["What's blocking us right now?", "Who is overloaded this week?", "What should I chase before the deadline?"].map((q) => (
                      <button key={q} onClick={() => setChatVal(q)} style={chipS(false)}>{q}</button>
                    ))}
                  </div>
                </div>
              )}
              {(p.chat || []).map((m) => (
                <div key={m.id} style={{ display: "flex", justifyContent: m.who === "me" ? "flex-end" : "flex-start", gap: 7 }}>
                  {m.who === "ai" && <span style={{ width: 24, height: 24, borderRadius: "50%", background: "var(--s2)", border: "1px solid var(--bdr)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, marginTop: 2 }}><Bot size={12} style={{ color: "var(--acc)" }} /></span>}
                  <div style={{ maxWidth: "84%", display: "flex", flexDirection: "column", gap: 7, alignItems: m.who === "me" ? "flex-end" : "flex-start" }}>
                    <div style={{ padding: "8px 12px", borderRadius: m.who === "me" ? "12px 12px 4px 12px" : "12px 12px 12px 4px", background: m.who === "me" ? "var(--acc)" : "var(--s2)", color: m.who === "me" ? "#fff" : "var(--txt)", fontSize: 12.5, lineHeight: 1.55, whiteSpace: "pre-wrap" }}>
                      {m.text}
                      <FileBadges files={m.files} />
                    </div>
                    {(m.docs || []).map((d, i) => <DocCard key={i} doc={d} />)}
                  </div>
                </div>
              ))}
              {chatBusy && <div style={{ display: "flex", gap: 7 }}><span style={{ width: 24, height: 24, borderRadius: "50%", background: "var(--s2)", border: "1px solid var(--bdr)", display: "flex", alignItems: "center", justifyContent: "center" }}><Bot size={12} style={{ color: "var(--acc)" }} /></span><div style={{ padding: "6px 12px", borderRadius: 12, background: "var(--s2)" }}><TypingDots /></div></div>}
            </div>
            <AttachStrip atts={chatAtts} setAtts={setChatAtts} />
            <div style={{ display: "flex", gap: 8, marginTop: chatAtts.length ? 8 : 0 }}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => { e.preventDefault(); pickAttachments(e.dataTransfer?.files, setChatAtts, toast); }}>
              <ClipButton fileRef={chatFileRef} onPick={(fs) => pickAttachments(fs, setChatAtts, toast)} />
              <input className="inp" style={{ flex: 1 }} placeholder={chatAtts.length ? "What should I do with it?" : "Ask about deep details — or paste a screenshot"} value={chatVal} onChange={(e) => setChatVal(e.target.value)} onPaste={(e) => { const fs = filesFromPaste(e); if (fs.length) { e.preventDefault(); pickAttachments(fs, setChatAtts, toast); } }} onKeyDown={(e) => e.key === "Enter" && sendChat()} />
              <Btn title="Send" icon={chatBusy ? Loader2 : Send} disabled={chatBusy || (!chatVal.trim() && !chatAtts.length)} onClick={sendChat} style={{ width: 44, padding: 0 }}> </Btn>
            </div>
          </Section>

          )}

          {tab === "files" && (
          <Section style={{ background: "var(--s2)" }}>
            <CardLabel>Project internal sheet</CardLabel>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "9px 16px", fontSize: 12.5 }}>
              <KV k="Project ID" v={<span style={{ fontFamily: MONO }}>{p.projectId} <span style={{ color: "var(--txt3)", fontSize: 10 }}>({p.idMode})</span></span>} />
              <KV k="Status" v={<span style={{ color: statColor(p.status), fontWeight: 600 }}>{p.status}</span>} />
              <KV k="Client" v={p.clientName || "—"} />
              <KV k="Client ID" v={<span style={{ fontFamily: MONO }}>{p.clientId || "—"}</span>} />
              <KV k="Industry" v={p.industry || "—"} />
              <KV k="Org size" v={p.orgSize || "—"} />
              <KV k="Contact" v={p.contact?.name ? `${p.contact.name}${p.contact.designation ? " · " + p.contact.designation : ""}` : "—"} />
              <KV k="Created" v={fmtDate((p.createdAt || "").slice(0, 10))} />
              {p.startDate && <KV k="Start" v={fmtDate(p.startDate)} />}
              <KV k="Drive" v={<span style={{ fontFamily: MONO, fontSize: 11 }}>{pmPath(p.projectId)}</span>} />
              {(p.linkedIds || []).length > 0 && <div style={{ gridColumn: "1 / -1" }}><KV k="Linked IDs (GW / PCB)" v={<span style={{ fontFamily: MONO, fontSize: 11 }}>{p.linkedIds.join(", ")}</span>} /></div>}
            </div>
          </Section>
          )}
        </div>

        {/* RIGHT — the standing facts, alongside the overview only */}
        {tab === "overview" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <Section>
            <CardLabel>Sanction gates</CardLabel>
            <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
              {gates.map(([label, ok]) => (
                <div key={label} style={{ display: "flex", alignItems: "center", gap: 9, fontSize: 12.5 }}>
                  {ok ? <CheckCircle2 size={16} style={{ color: "var(--green)" }} /> : <X size={16} style={{ color: "var(--red)" }} />}
                  <span style={{ flex: 1, color: ok ? "var(--txt)" : "var(--red)", fontWeight: ok ? 500 : 600 }}>{label}</span>
                  <span style={{ fontSize: 10.5, fontWeight: 700, color: ok ? "var(--green)" : "var(--red)" }}>{ok ? "CLEARED" : "MISSING"}</span>
                </div>
              ))}
            </div>
          </Section>

          <Section>
            <CardLabel right={isPM && <button onClick={() => { setTeamDraft(p.team || []); setEditTeam(!editTeam); }} style={{ background: "none", border: "none", color: editTeam ? "var(--txt2)" : "var(--acc)", cursor: "pointer", fontSize: 12, fontWeight: 600 }}>{editTeam ? "Cancel" : "Edit team"}</button>}>Team roster</CardLabel>
            {editTeam ? (
              <div>
                <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                  {TEAM_SLOTS.map((slot) => (
                    <div key={slot} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ fontSize: 11, width: 118, color: "var(--txt2)", fontWeight: 600 }}>{slot}{slot.startsWith("PM") && <span style={{ color: "var(--red)" }}> *</span>}</span>
                      <select className="inp" style={{ flex: 1, padding: "6px 8px" }} value={slotUser(slot)} onChange={(e) => setSlot(slot, e.target.value)}>
                        <option value="">— unassigned —</option>
                        {users.filter((u) => u.role !== "superadmin").map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                      </select>
                    </div>
                  ))}
                </div>
                {!teamDraft.some((t) => t.slot.startsWith("PM") && t.userId) && <div style={{ color: "var(--amber)", fontSize: 11, marginTop: 8, display: "flex", gap: 6, alignItems: "center" }}><AlertTriangle size={12} /> A PM must be assigned.</div>}
                <div style={{ marginTop: 10, display: "flex", gap: 8 }}>
                  <Btn small kind="green" icon={CheckCircle2} disabled={!teamDraft.some((t) => t.slot.startsWith("PM") && t.userId)} onClick={saveTeam}>Save team</Btn>
                  <Btn small kind="ghost" onClick={() => setEditTeam(false)}>Cancel</Btn>
                </div>
              </div>
            ) : (p.team || []).length === 0 ? <div style={{ fontSize: 12.5, color: "var(--txt2)" }}>No team assigned.</div> : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {(p.team || []).map((t, i) => {
                  const u = users.find((x) => x.id === t.userId);
                  return (
                    <div key={i} style={{ display: "flex", alignItems: "center", gap: 9 }}>
                      <AvatarDot user={u} size={30} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 600, fontSize: 12.5 }}>{u?.name || "—"}</div>
                        <div style={{ fontSize: 10.5, color: "var(--txt2)" }}>{t.slot}</div>
                      </div>
                      {t.slot.startsWith("PM") && <Pill color="var(--purple)">PM</Pill>}
                    </div>
                  );
                })}
              </div>
            )}
          </Section>

          <Section>
            <CardLabel>Stage-wise timeline</CardLabel>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8, fontSize: 11 }}>
              <span style={{ color: "var(--txt2)", fontWeight: 600 }}>{fmtDate(timelineStart)}</span>
              <span style={{ fontWeight: 800, color: dl < 0 ? "var(--red)" : dl <= 14 ? "var(--amber)" : "var(--green)" }}>{dl < 0 ? `OVERDUE ${-dl}d` : `${dl}d left`}</span>
              <span style={{ color: "var(--txt2)", fontWeight: 600 }}>{fmtDate(p.deadline)}</span>
            </div>
            <div style={{ position: "relative", height: 10, background: "var(--s2)", borderRadius: 99, overflow: "hidden" }}>
              <div style={{ position: "absolute", left: 0, top: 0, height: "100%", width: `${elapsedPct}%`, background: dl < 0 ? "var(--red)" : elapsedPct > 75 ? "var(--amber)" : "var(--acc)", borderRadius: 99, transition: "width .3s" }} />
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6, fontSize: 10.5, color: "var(--txt3)" }}>
              <span>{elapsedPct}% elapsed</span><span>{pct}% work done</span>
            </div>
          </Section>

          {(p.lldCustomer || p.lldDesigner) && (
          <Section>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: showLLD ? 12 : 0 }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: "var(--txt2)", textTransform: "uppercase", letterSpacing: ".06em" }}>LLDs</span>
              <Pill color="var(--green)">C · {p.lldCustomer?.mode || "—"}</Pill>
              <Pill color="var(--green)">D · {p.lldDesigner?.mode || "—"}</Pill>
              <button onClick={() => setShowLLD((s) => !s)} style={{ marginLeft: "auto", background: "none", border: "none", color: "var(--acc)", cursor: "pointer", fontSize: 12, fontWeight: 600, display: "flex", alignItems: "center", gap: 4 }}>{showLLD ? "Hide" : "View"} <ChevronDown size={13} style={{ transform: showLLD ? "rotate(180deg)" : "none", transition: "transform .2s" }} /></button>
            </div>
            {showLLD && (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {[["Customer LLD", p.lldCustomer], ["Designer LLD", p.lldDesigner]].map(([label, lld]) => (
                  <div key={label}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: "var(--txt)", marginBottom: 4, display: "flex", alignItems: "center", gap: 6 }}><FileText size={12} style={{ color: "var(--acc)" }} /> {label} {lld?.fileName && <span style={{ fontFamily: MONO, fontSize: 10, color: "var(--txt3)" }}>{lld.fileName}</span>}</div>
                    <pre style={{ margin: 0, padding: 10, background: "var(--s2)", borderRadius: 8, fontSize: 11.5, whiteSpace: "pre-wrap", fontFamily: "inherit", color: "var(--txt2)", lineHeight: 1.55, maxHeight: 200, overflow: "auto" }}>{lld?.text || "—"}</pre>
                  </div>
                ))}
              </div>
            )}
          </Section>
          )}
        </div>
        )}
      </div>
    </div>
  );
}

/* ═══ MODULE 2 — DAILY SCRUM ═════════════════════════════════════════════ */
const SCRUM_PLACEHOLDER = `e.g. — project ID esp-32-123: check the gerber file, rahul 12pm to 1pm. If the gerber is fine, great; if not, verify the schematic and submit a report in an hour. gargi checks the BoM 12 to 1pm.
Ask akshay to have the client communicated by 2pm.`;

function ScrumModule() {
  const { notes, setNotes, tasks, setTasks, projects, users, me, toast, sheetSync, memory, now } = useCtx();
  const [date, setDate] = useState(todayStr());
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(null);

  const normalize = (res) => ({
    summary: res.summary || "",
    engine: res.engine || "ai",
    tasks: (res.tasks || []).map((t) => {
      const first = String(t.assignee || "").toLowerCase().split(" ")[0];
      const u = users.find((x) => x.name.toLowerCase().split(" ")[0] === first) || users.find((x) => first && x.name.toLowerCase().includes(first));
      const p = projects.find((x) => normId(x.projectId) === normId(t.projectId));
      return { ...t, id: uid(), include: true, assigneeId: u?.id || "", projectId: p ? p.projectId : (t.projectId || ""), linked: !!p };
    }),
  });

  const organize = async () => {
    if (!draft.trim()) return;
    setBusy(true); setPreview(null);
    try { const res = await claude(scrumPrompt(draft, date, users, projects, memory)); setPreview(normalize(res)); }
    catch (e) { const fb = fallbackScrum(draft, date, users, projects); setPreview(normalize({ ...fb, engine: "offline" })); toast("AI unreachable — used the offline parser", "amber"); }
    setBusy(false);
  };
  const updPrev = (i, patch) => setPreview((pv) => ({ ...pv, tasks: pv.tasks.map((t, j) => (j === i ? { ...t, ...patch } : t)) }));

  const save = (pushTasks) => {
    const dayNotes = notes.filter((n) => n.date === date);
    const note = { id: uid(), date, noteNo: dayNotes.length + 1, time: nowHM(), raw: draft, organized: preview, origin: "manual", by: me, createdAt: new Date().toISOString() };
    let created = 0;
    if (pushTasks && preview) {
      const newTasks = preview.tasks.filter((t) => t.include).map((t) => ({
        id: uid(), projectId: t.projectId, linked: t.linked, title: t.title, assigneeId: t.assigneeId, assigneeName: t.assignee || "",
        date, startTime: t.startTime || "", endTime: t.endTime || "", steps: t.steps || [], conditions: t.conditions || [],
        status: "pending", origin: "scrum", noteId: note.id, createdBy: me, createdAt: new Date().toISOString(), work: {},
        // filed straight under the right stage of that project's plan
        stageId: guessStageId(projects.find((x) => x.projectId === t.projectId)?.plan?.stages || [], { title: t.title, date, assigneeName: t.assignee || "" }),
      }));
      created = newTasks.length;
      setTasks((x) => [...newTasks, ...x]);
      [...new Set(newTasks.filter((t) => t.linked).map((t) => t.projectId))].forEach((pid) =>
        sheetSync(`${pmPath(pid)}Checklist.xlsx`, `${newTasks.filter((t) => t.projectId === pid).length} task(s) appended from Scrum Note ${note.noteNo}`));
    }
    setNotes((x) => [note, ...x]);
    toast(created ? `Note ${note.noteNo} saved — ${created} task(s) created` : `Note ${note.noteNo} saved`, "green");
    setDraft(""); setPreview(null);
  };

  const dayNotes = notes.filter((n) => n.date === date).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div className="card" style={{ padding: 18 }}>
        <SectionTitle icon={NotebookPen} right={<input type="date" className="inp" style={{ width: 160 }} value={date} onChange={(e) => setDate(e.target.value)} />}>
          Daily scrum — write it as it comes
        </SectionTitle>
        <textarea className="inp" rows={5} style={{ lineHeight: 1.6, fontSize: 13.5 }} placeholder={SCRUM_PLACEHOLDER} value={draft} onChange={(e) => setDraft(e.target.value)} />
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 10, flexWrap: "wrap" }}>
          <Btn icon={busy ? Loader2 : Sparkles} disabled={busy || !draft.trim()} onClick={organize} style={busy ? { pointerEvents: "none" } : {}}>{busy ? "Organising…" : "Organise with AI"}</Btn>
          <span style={{ fontSize: 11.5, color: "var(--txt2)" }}>Mention the project ID, people, time windows and any if/else — AI turns it into assigned, time-boxed tasks.</span>
        </div>
        {busy && <div style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 8, color: "var(--txt2)", fontSize: 12.5 }}><Loader2 className="spin" size={14} /> Splitting the note into tasks, matching people and projects, extracting contingencies…</div>}
        {preview && (
          <div className="fade" style={{ marginTop: 14, borderTop: "1px dashed var(--bdr2)", paddingTop: 14 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
              <Pill color={preview.engine === "offline" ? "var(--amber)" : "var(--purple)"}>{preview.engine === "offline" ? "Offline parse — review carefully" : "AI organised"}</Pill>
              <span style={{ fontSize: 12.5, color: "var(--txt2)" }}>{preview.summary}</span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {preview.tasks.map((t, i) => (
                <div key={t.id} style={{ border: "1px solid var(--bdr)", borderRadius: 11, padding: 12, background: "var(--s2)", opacity: t.include ? 1 : 0.45 }}>
                  <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
                    <input type="checkbox" checked={t.include} onChange={(e) => updPrev(i, { include: e.target.checked })} style={{ marginTop: 3 }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <input className="inp" style={{ fontWeight: 600, background: "var(--s1)", marginBottom: 8 }} value={t.title} onChange={(e) => updPrev(i, { title: e.target.value })} />
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                        {t.linked ? <Pill color="var(--blue)" style={{ fontFamily: MONO }}>{t.projectId}</Pill> : <Pill color="var(--amber)"><AlertTriangle size={10} /> {t.projectId || "no project"} · unlinked</Pill>}
                        <select className="inp" style={{ width: 150, padding: "5px 9px", background: "var(--s1)" }} value={t.assigneeId} onChange={(e) => updPrev(i, { assigneeId: e.target.value })}>
                          <option value="">— assignee —</option>
                          {users.filter((u) => u.role !== "superadmin").map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                        </select>
                        <input type="time" className="inp" style={{ width: 108, padding: "5px 9px", background: "var(--s1)", fontFamily: MONO }} value={t.startTime} onChange={(e) => updPrev(i, { startTime: e.target.value })} />
                        <span style={{ color: "var(--txt3)" }}>→</span>
                        <input type="time" className="inp" style={{ width: 108, padding: "5px 9px", background: "var(--s1)", fontFamily: MONO }} value={t.endTime} onChange={(e) => updPrev(i, { endTime: e.target.value })} />
                      </div>
                      {t.steps?.length > 0 && (
                        <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 4 }}>
                          {t.steps.map((s, si) => <div key={si} style={{ fontSize: 12.5, color: "var(--txt2)", display: "flex", gap: 7 }}><span style={{ color: "var(--txt3)", fontFamily: MONO, fontSize: 11 }}>{si + 1}.</span>{s}</div>)}
                        </div>
                      )}
                      <ConditionRail conditions={t.conditions} />
                    </div>
                  </div>
                </div>
              ))}
            </div>
            <div style={{ display: "flex", gap: 10, marginTop: 13, flexWrap: "wrap" }}>
              <Btn kind="ghost" onClick={() => save(false)}>Save note only</Btn>
              <Btn icon={ListChecks} onClick={() => save(true)}>Save note + create {preview.tasks.filter((t) => t.include).length} task(s)</Btn>
            </div>
          </div>
        )}
      </div>

      <div>
        <SectionTitle icon={Calendar}>Notes — {fmtDate(date)} <Pill color="var(--txt2)">{dayNotes.length}</Pill></SectionTitle>
        {dayNotes.length === 0 ? (
          <div className="card"><Empty icon={NotebookPen} title="No notes for this day" sub="Every save becomes Note 1, Note 2… — a clean date-and-time-wise history. Task branches write their own story notes here automatically." /></div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {dayNotes.map((n) => <NoteCard key={n.id} n={n} />)}
          </div>
        )}
      </div>
    </div>
  );
}

function NoteCard({ n }) {
  const { users } = useCtx();
  const [open, setOpen] = useState(false);
  const by = users.find((u) => u.id === n.by);
  const sys = n.origin === "system";
  return (
    <div className="card" style={{ padding: 15, borderLeft: sys ? "3px solid var(--purple)" : "3px solid var(--acc)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap" }}>
        <span style={{ fontWeight: 700, fontSize: 13.5 }}>Note {n.noteNo}</span>
        <span style={{ fontFamily: MONO, fontSize: 11.5, color: "var(--txt2)" }}>{n.time}</span>
        {sys ? <Pill color="var(--purple)"><GitBranch size={10} /> Auto story from task branch</Pill> : <Pill color="var(--txt2)">{by?.name || "—"}</Pill>}
        {n.organized?.tasks?.length > 0 && <Pill color="var(--blue)">{n.organized.tasks.filter((t) => t.include !== false).length} task(s)</Pill>}
        <button onClick={() => setOpen(!open)} style={{ marginLeft: "auto", background: "none", border: "none", color: "var(--txt2)", cursor: "pointer", display: "flex", alignItems: "center", gap: 4, fontSize: 12 }}>
          raw note <ChevronDown size={13} style={{ transform: open ? "rotate(180deg)" : "none", transition: "transform .2s" }} />
        </button>
      </div>
      {n.organized?.summary && <div style={{ fontSize: 12.5, color: "var(--txt2)", marginTop: 7 }}>{n.organized.summary}</div>}
      {n.organized?.tasks?.length > 0 && (
        <div style={{ marginTop: 9, display: "flex", flexDirection: "column", gap: 6 }}>
          {n.organized.tasks.filter((t) => t.include !== false).map((t, i) => (
            <div key={i} style={{ fontSize: 12.5, display: "flex", gap: 8, alignItems: "flex-start", flexWrap: "wrap" }}>
              <span style={{ fontFamily: MONO, fontSize: 10.5, color: "var(--txt3)", marginTop: 2 }}>{String(i + 1).padStart(2, "0")}</span>
              <span style={{ flex: 1, minWidth: 160 }}>{t.title}</span>
              {t.projectId && <Pill color="var(--blue)" style={{ fontFamily: MONO }}>{t.projectId}</Pill>}
              {(t.startTime || t.endTime) && <span style={{ fontFamily: MONO, fontSize: 11, color: "var(--txt2)" }}>{t.startTime}–{t.endTime}</span>}
              {t.conditions?.length > 0 && <Pill color="var(--amber)"><GitBranch size={10} /> {t.conditions.length} if/else</Pill>}
            </div>
          ))}
        </div>
      )}
      {open && <pre style={{ marginTop: 10, padding: 11, background: "var(--s2)", borderRadius: 9, fontSize: 12, whiteSpace: "pre-wrap", fontFamily: "inherit", color: "var(--txt2)", lineHeight: 1.6 }}>{n.raw}</pre>}
    </div>
  );
}

/* ═══ MODULE 3 — MY PROJECTS & TASKS ═════════════════════════════════════ */
const STATUS_DOT = { pending: "var(--txt3)", "in-progress": "var(--blue)", blocked: "var(--amber)", done: "var(--green)" };
const DEFAULT_QS = ["What exactly did you produce, and what is the file called?", "Where exactly is it stored — full Drive path?", "How did you verify it actually meets the task's scope?"];

function TasksModule() {
  const { tasks, setTasks, projects, users, me, now } = useCtx();
  const my = users.find((u) => u.id === me);
  const isAdmin = ["superadmin", "dept_head"].includes(my?.role);
  const isPM = my?.role === "pm";
  const myProjectIds = projects.filter((p) => (p.team || []).some((t) => t.userId === me)).map((p) => p.projectId);
  const visible = tasks.filter((t) => isAdmin ? true : isPM ? (t.assigneeId === me || t.createdBy === me || myProjectIds.includes(t.projectId)) : t.assigneeId === me);
  const [group, setGroup] = useState(isAdmin || isPM ? "project" : "person");
  const [personF, setPersonF] = useState("all");
  const [projF, setProjF] = useState("all");
  const [workT, setWorkT] = useState(null);
  const [compT, setCompT] = useState(null);
  const filtered = visible.filter((t) => (personF === "all" || t.assigneeId === personF) && (projF === "all" || t.projectId === projF));
  const newProjects = projects.filter((p) => Date.now() - new Date(p.createdAt).getTime() < 7 * 86400000 && (isAdmin || (p.team || []).some((t) => t.userId === me)));
  const startTask = (t) => { setTasks((ts) => ts.map((x) => (x.id === t.id ? { ...x, status: "in-progress", startedAt: x.startedAt || new Date().toISOString() } : x))); setWorkT({ ...t, status: "in-progress" }); };

  const projGroups = useMemo(() => {
    const map = new Map();
    for (const t of filtered) { const k = t.projectId || "__unlinked__"; if (!map.has(k)) map.set(k, []); map.get(k).push(t); }
    return [...map.entries()];
  }, [filtered]);
  const personGroups = useMemo(() => {
    const map = new Map();
    for (const t of filtered) { const k = t.assigneeId || "__none__"; if (!map.has(k)) map.set(k, []); map.get(k).push(t); }
    return [...map.entries()];
  }, [filtered]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {newProjects.length > 0 && (
        <div className="card" style={{ padding: 14 }}>
          <SectionTitle icon={Zap}>New projects</SectionTitle>
          <div style={{ display: "flex", gap: 9, flexWrap: "wrap" }}>
            {newProjects.map((p) => (
              <div key={p.id} style={{ border: "1px solid var(--bdr)", borderRadius: 10, padding: "9px 13px", background: "var(--s2)" }}>
                <div style={{ fontFamily: MONO, fontSize: 11.5, color: "var(--acc)", fontWeight: 600 }}>{p.projectId}</div>
                <div style={{ fontSize: 12.5, fontWeight: 600, marginTop: 2 }}>{p.name}</div>
                <div style={{ fontSize: 11, color: "var(--txt2)", marginTop: 2 }}>{fmtDate(p.deadline)} · {p.status}</div>
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="card" style={{ padding: 14, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <Seg value={group} onChange={setGroup} options={[{ k: "project", label: "By project", icon: FolderPlus }, { k: "person", label: "By person", icon: Users }]} />
        <select className="inp" style={{ width: 170 }} value={personF} onChange={(e) => setPersonF(e.target.value)}>
          <option value="all">All people</option>
          {users.filter((u) => u.role !== "superadmin").map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
        </select>
        <select className="inp" style={{ width: 200, fontFamily: MONO, fontSize: 12 }} value={projF} onChange={(e) => setProjF(e.target.value)}>
          <option value="all">All projects</option>
          {projects.map((p) => <option key={p.id} value={p.projectId}>{p.projectId}</option>)}
        </select>
        <span style={{ marginLeft: "auto", fontSize: 12, color: "var(--txt2)" }}>{filtered.length} task(s){!isAdmin && " · your view"}</span>
      </div>

      {filtered.length === 0 ? (
        <div className="card"><Empty icon={ListChecks} title="No tasks here yet" sub="Tasks arrive from Daily Scrum — write a note, organise it with AI, and push. Branch sub-tasks land here too." /></div>
      ) : group === "project" ? (
        projGroups.map(([pid, ts]) => {
          const p = projects.find((x) => x.projectId === pid);
          const done = ts.filter((t) => t.status === "done").length;
          return (
            <div key={pid} className="card" style={{ overflow: "hidden" }}>
              <div style={{ padding: "13px 16px", borderBottom: "1px solid var(--bdr)", display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", background: "var(--s2)" }}>
                {p ? (<>
                  <span style={{ fontFamily: MONO, fontWeight: 600, fontSize: 13, color: "var(--acc)" }}>{p.projectId}</span>
                  <span style={{ fontWeight: 700, fontSize: 13.5 }}>{p.name}</span>
                  <Pill color={statColor(p.status)}>{p.status}</Pill>
                </>) : <Pill color="var(--amber)"><AlertTriangle size={11} /> Unlinked tasks</Pill>}
                <div style={{ display: "flex", alignItems: "center", gap: 9, marginLeft: "auto", minWidth: 200, flex: 1, maxWidth: 320 }}>
                  <Progress pct={(done / ts.length) * 100} color="var(--green)" />
                  <span style={{ fontSize: 11.5, fontFamily: MONO, color: "var(--txt2)", whiteSpace: "nowrap" }}>{done}/{ts.length} done</span>
                </div>
              </div>
              <div>{ts.map((t) => <TaskRow key={t.id} t={t} now={now} showAssignee onStart={() => startTask(t)} onWork={() => setWorkT(t)} onComplete={() => setCompT(t)} />)}</div>
            </div>
          );
        })
      ) : (
        personGroups.map(([uidK, ts]) => {
          const u = users.find((x) => x.id === uidK);
          const open = ts.filter((t) => t.status !== "done").length;
          return (
            <div key={uidK} className="card" style={{ overflow: "hidden" }}>
              <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--bdr)", display: "flex", alignItems: "center", gap: 10, background: "var(--s2)" }}>
                <AvatarDot user={u} size={28} />
                <span style={{ fontWeight: 700, fontSize: 13.5 }}>{u?.name || "Unassigned"}</span>
                <span style={{ fontSize: 11.5, color: "var(--txt2)" }}>{u?.title}</span>
                <Pill color={open ? "var(--blue)" : "var(--green)"} style={{ marginLeft: "auto" }}>{open} open</Pill>
              </div>
              <div>{ts.map((t) => <TaskRow key={t.id} t={t} now={now} showProject onStart={() => startTask(t)} onWork={() => setWorkT(t)} onComplete={() => setCompT(t)} />)}</div>
            </div>
          );
        })
      )}
      {workT && <WorkWindow t={tasks.find((x) => x.id === workT.id) || workT} onClose={() => setWorkT(null)} onComplete={(w) => { setWorkT(null); setCompT({ ...(tasks.find((x) => x.id === workT.id) || workT), work: w }); }} />}
      {compT && <CompleteFlow t={compT} onClose={() => setCompT(null)} />}
    </div>
  );
}

function TaskRow({ t, now, showAssignee, showProject, onStart, onWork, onComplete }) {
  const { users, me } = useCtx();
  const [open, setOpen] = useState(false);
  const my = users.find((u) => u.id === me);
  const canAct = t.assigneeId === me || ["superadmin", "dept_head"].includes(my?.role) || t.createdBy === me;
  const u = users.find((x) => x.id === t.assigneeId);
  return (
    <div style={{ borderBottom: "1px solid var(--bdr)" }}>
      <div className="rowHover" style={{ padding: "11px 16px", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span style={{ width: 9, height: 9, borderRadius: "50%", background: STATUS_DOT[t.status], flexShrink: 0 }} />
        <span style={{ fontWeight: 600, fontSize: 13, flex: 1, minWidth: 180, textDecoration: t.status === "done" ? "line-through" : "none", color: t.status === "done" ? "var(--txt2)" : "var(--txt)" }}>{t.title}</span>
        {showProject && t.projectId && <Pill color="var(--blue)" style={{ fontFamily: MONO }}>{t.projectId}</Pill>}
        {showAssignee && (u ? <span style={{ display: "flex", alignItems: "center", gap: 6 }}><AvatarDot user={u} size={21} /><span style={{ fontSize: 12, color: "var(--txt2)" }}>{u.name}</span></span> : <Pill color="var(--amber)">unassigned</Pill>)}
        {(t.startTime || t.endTime) && <span style={{ fontFamily: MONO, fontSize: 11.5, color: "var(--txt2)" }}>{t.startTime || "…"}–{t.endTime || "…"}</span>}
        <Countdown task={t} now={now} />
        {t.conditions?.length > 0 && <Pill color="var(--amber)"><GitBranch size={10} /> {t.conditions.length}</Pill>}
        {t.origin === "branch" && <Pill color="var(--purple)"><GitBranch size={10} /> branch</Pill>}
        {t.escalated && <Pill color="var(--red)"><Shield size={10} /> Shreya</Pill>}
        {t.status === "done" && t.aiVerification && <Pill color="var(--green)"><Bot size={10} /> {t.aiVerification.score}/10</Pill>}
        <div style={{ display: "flex", gap: 7, marginLeft: "auto" }}>
          {canAct && t.status === "pending" && <Btn small icon={Play} onClick={onStart}>Start</Btn>}
          {canAct && (t.status === "in-progress" || t.status === "blocked") && (<>
            <Btn small kind="ghost" icon={FileText} onClick={onWork}>Work window</Btn>
            <Btn small kind="green" icon={CheckCircle2} onClick={onComplete}>Complete Now</Btn>
          </>)}
          <button onClick={() => setOpen(!open)} style={{ background: "none", border: "none", color: "var(--txt3)", cursor: "pointer" }}><ChevronDown size={15} style={{ transform: open ? "rotate(180deg)" : "none", transition: "transform .2s" }} /></button>
        </div>
      </div>
      {open && (
        <div className="fade" style={{ padding: "0 16px 13px 35px", fontSize: 12.5, color: "var(--txt2)" }}>
          {t.steps?.length > 0 && <div style={{ marginBottom: 7 }}>{t.steps.map((s, i) => <div key={i} style={{ display: "flex", gap: 7 }}><span style={{ fontFamily: MONO, fontSize: 11, color: "var(--txt3)" }}>{i + 1}.</span>{s}</div>)}</div>}
          <ConditionRail conditions={t.conditions} />
          {t.work?.whatDone && <div style={{ marginTop: 8 }}><b style={{ color: "var(--txt)" }}>Work log:</b> {t.work.whatDone}{t.work.fileName && <span style={{ fontFamily: MONO, fontSize: 11.5 }}> · {t.work.fileName} @ {t.work.fileLocation}</span>}</div>}
          {t.lastFeedback && <div style={{ marginTop: 6, color: "var(--amber)" }}><b>Last AI feedback:</b> {t.lastFeedback}</div>}
          {t.aiVerification?.feedback && <div style={{ marginTop: 6, color: "var(--green)" }}><b>Verified:</b> {t.aiVerification.feedback}</div>}
          {t.escalated && <div style={{ marginTop: 6, color: "var(--red)" }}><b>Escalated to Shreya:</b> {t.escalated.note || "—"}</div>}
        </div>
      )}
    </div>
  );
}

function WorkWindow({ t, onClose, onComplete }) {
  const { setTasks, projects, memory, toast, now } = useCtx();
  const [w, setW] = useState({ whatDone: t.work?.whatDone || "", fileName: t.work?.fileName || "", fileLocation: t.work?.fileLocation || (t.projectId ? `${pmPath(t.projectId)}Reports/` : ""), attach: t.work?.attach || "" });
  const [checks, setChecks] = useState(t.stepsDone || []);
  const p = projects.find((x) => x.projectId === t.projectId);
  const sitemaps = memory.filter((m) => m.type === "sitemap");
  const bar = memory.find((m) => m.type === "instruction");
  const save = (silent) => { setTasks((ts) => ts.map((x) => (x.id === t.id ? { ...x, work: w, stepsDone: checks } : x))); if (!silent) { toast("Progress saved", "green"); onClose(); } };
  return (
    <Modal title={t.title} sub={`${t.projectId || "unlinked"} · ${t.startTime || "…"}–${t.endTime || "…"} · full scope on the left, your evidence on the right`} onClose={onClose} width={900}
      footer={<>
        <Btn kind="ghost" onClick={() => save(false)}>Save progress</Btn>
        <Btn kind="green" icon={CheckCircle2} onClick={() => { save(true); onComplete(w); }}>Complete Now</Btn>
      </>}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1.15fr", gap: 16 }}>
        <div style={{ background: "var(--s2)", border: "1px solid var(--bdr)", borderRadius: 11, padding: 14, fontSize: 12.5 }}>
          <div style={{ fontWeight: 700, fontSize: 12, textTransform: "uppercase", letterSpacing: ".05em", color: "var(--txt2)", marginBottom: 9 }}>Scope & guidance</div>
          {t.steps?.length > 0 ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 10 }}>
              {t.steps.map((s, i) => (
                <label key={i} style={{ display: "flex", gap: 8, alignItems: "flex-start", cursor: "pointer" }}>
                  <input type="checkbox" checked={checks.includes(i)} onChange={() => setChecks((c) => (c.includes(i) ? c.filter((x) => x !== i) : [...c, i]))} style={{ marginTop: 2 }} />
                  <span style={{ textDecoration: checks.includes(i) ? "line-through" : "none", color: checks.includes(i) ? "var(--txt3)" : "var(--txt)" }}>{s}</span>
                </label>
              ))}
            </div>
          ) : <div style={{ color: "var(--txt2)", marginBottom: 10 }}>No sub-steps written — the title is the scope.</div>}
          <ConditionRail conditions={t.conditions} />
          <div style={{ marginTop: 12, borderTop: "1px dashed var(--bdr2)", paddingTop: 10 }}>
            <div style={{ fontWeight: 700, fontSize: 11, textTransform: "uppercase", letterSpacing: ".05em", color: "var(--txt2)", marginBottom: 6 }}>Where things live</div>
            {t.projectId && <div style={{ fontFamily: MONO, fontSize: 11, color: "var(--acc)", marginBottom: 5 }}>{pmPath(t.projectId)} → Checklist.xlsx</div>}
            {sitemaps.map((m) => <div key={m.id} style={{ fontFamily: MONO, fontSize: 10.5, color: "var(--txt3)", whiteSpace: "pre-wrap", marginBottom: 5 }}>{m.content.split("\n").slice(0, 2).join("\n")}</div>)}
          </div>
          {bar && <div style={{ marginTop: 10, padding: "8px 10px", borderRadius: 8, background: "var(--soft)", border: "1px solid var(--bdr)", fontSize: 11.5, color: "var(--txt2)" }}><b style={{ color: "var(--acc)" }}>{bar.title}:</b> {bar.content}</div>}
          {p && <div style={{ marginTop: 10, fontSize: 11.5, color: "var(--txt2)" }}>Deadline {fmtDate(p.deadline)} · <Countdown task={t} now={now} /></div>}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <Field label="What did you do?" req><textarea className="inp" rows={4} placeholder="I created / checked / fixed … — be concrete, the AI gate reads this" value={w.whatDone} onChange={(e) => setW({ ...w, whatDone: e.target.value })} /></Field>
          <Field label="File produced (name)" req><input className="inp" style={{ fontFamily: MONO, fontSize: 12 }} placeholder="e.g. 2026-08-04_gerber-DRC-report.pdf" value={w.fileName} onChange={(e) => setW({ ...w, fileName: e.target.value })} /></Field>
          <Field label="Stored at (Drive path)" req><input className="inp" style={{ fontFamily: MONO, fontSize: 12 }} value={w.fileLocation} onChange={(e) => setW({ ...w, fileLocation: e.target.value })} /></Field>
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, color: "var(--txt2)", cursor: "pointer" }}>
            <Upload size={14} />
            <span>{w.attach ? <span style={{ fontFamily: MONO, fontSize: 12, color: "var(--txt)" }}>{w.attach}</span> : "Attach the file as reference (Drive upload is the integration seam)"}</span>
            <input type="file" style={{ display: "none" }} onChange={(e) => { const f = e.target.files[0]; if (f) setW({ ...w, attach: f.name, fileName: w.fileName || f.name }); }} />
          </label>
          <div style={{ fontSize: 11.5, color: "var(--txt3)", lineHeight: 1.6 }}>Closing runs the AI gate: it asks pointed questions, checks the file + path against the sitemap, and fails vague closures. Full clarity in, quality out.</div>
        </div>
      </div>
    </Modal>
  );
}

function CompleteFlow({ t, onClose }) {
  const { setTasks, setNotes, notes, users, me, memory, toast, sheetSync } = useCtx();
  const work = t.work || {};
  const [phase, setPhase] = useState("confirm"); // confirm | questions | verdict | branch
  const [qs, setQs] = useState([]);
  const [qBusy, setQBusy] = useState(false);
  const [vBusy, setVBusy] = useState(false);
  const [verdict, setVerdict] = useState(null);
  const [esc, setEsc] = useState(false);
  const [escNote, setEscNote] = useState("");
  const [blocker, setBlocker] = useState("");
  const [rows, setRows] = useState([{ title: "", assigneeId: t.assigneeId || "", timebox: 60 }]);
  const [branchBusy, setBranchBusy] = useState(false);
  const finalize = (patch) => setTasks((ts) => ts.map((x) => (x.id === t.id ? { ...x, ...patch } : x)));
  const applyEsc = () => { if (!esc) return; finalize({ escalated: { to: SHREYA_ID, note: escNote, at: new Date().toISOString() } }); toast("Escalated to Shreya", "amber"); };

  const genQuestions = async () => {
    setPhase("questions"); setQBusy(true);
    try { const r = await claude(questionsPrompt(t, work, memory)); setQs((r.questions || DEFAULT_QS).slice(0, 3).map((q) => ({ q, a: "" }))); }
    catch { setQs(DEFAULT_QS.map((q) => ({ q, a: "" }))); }
    setQBusy(false);
  };
  const verify = async () => {
    setVBusy(true);
    try { const r = await claude(verdictPrompt(t, work, qs, memory)); setVerdict(r); }
    catch {
      const solid = qs.every((x) => x.a.trim().length > 10) && work.fileName && work.fileLocation;
      setVerdict({ verdict: solid ? "pass" : "fail", score: solid ? 6 : 3, feedback: solid ? "Offline heuristic: file + path + substantive answers present. Verify manually when AI is back." : "Offline heuristic: missing file name / storage path, or answers too thin to trust.", subtasks: [], offline: true });
    }
    setVBusy(false); setPhase("verdict");
  };
  const suggestBranch = async (why) => {
    setPhase("branch"); setBranchBusy(true); setBlocker(why || blocker);
    try { const r = await claude(branchPrompt(t, why || blocker, memory)); if (r.subtasks?.length) setRows(r.subtasks.map((s) => ({ title: s.title, assigneeId: t.assigneeId || "", timebox: s.timeboxMinutes || 60 }))); }
    catch { /* keep manual rows */ }
    setBranchBusy(false);
  };
  const createBranch = () => {
    const subs = rows.filter((r) => r.title.trim());
    if (!subs.length) { toast("Add at least one sub-task", "amber"); return; }
    const dt = todayStr(); const startHM = nowHM();
    const newTasks = subs.map((r) => ({ id: uid(), projectId: t.projectId, linked: t.linked !== false && !!t.projectId, title: r.title.trim(), assigneeId: r.assigneeId, date: dt, startTime: startHM, endTime: new Date(Date.now() + (r.timebox || 60) * 60000).toTimeString().slice(0, 5), steps: [], conditions: [], status: "pending", origin: "branch", stageId: t.stageId || "", parentTaskId: t.id, createdBy: me, createdAt: new Date().toISOString(), work: {} }));
    setTasks((ts) => [...newTasks, ...ts.map((x) => (x.id === t.id ? { ...x, status: "blocked", blockNote: blocker, work } : x))]);
    const dayN = notes.filter((n) => n.date === dt).length;
    const story = `Task "${t.title}"${t.projectId ? ` on ${t.projectId}` : ""} could not be closed${blocker ? ` — ${blocker}` : ""}. Branched into: ${subs.map((r, i) => `${i + 1}) ${r.title} → ${users.find((u) => u.id === r.assigneeId)?.name || "unassigned"} (${r.timebox || 60}m)`).join("; ")}. Clock started ${startHM}.`;
    setNotes((n) => [{ id: uid(), date: dt, noteNo: dayN + 1, time: startHM, raw: story, organized: { summary: "Auto story — a stuck task branched into timeboxed sub-tasks.", engine: "system", tasks: newTasks.map((x) => ({ title: x.title, projectId: x.projectId, assigneeId: x.assigneeId, startTime: x.startTime, endTime: x.endTime, conditions: [], include: true })) }, origin: "system", by: me, createdAt: new Date().toISOString() }, ...n]);
    if (t.projectId && t.linked !== false) sheetSync(`${pmPath(t.projectId)}Checklist.xlsx`, `${newTasks.length} branch task(s) from "${t.title}"`);
    applyEsc();
    toast(`${newTasks.length} sub-task(s) created — story written to today's scrum`, "green");
    onClose();
  };
  const closePass = () => {
    finalize({ status: "done", completedAt: new Date().toISOString(), work, aiVerification: { questions: qs, verdict: verdict.verdict, score: verdict.score, feedback: verdict.feedback, offline: !!verdict.offline } });
    if (t.projectId && t.linked !== false) {
      sheetSync(`${pmPath(t.projectId)}Checklist.xlsx`, `"${t.title}" done · score ${verdict.score}/10`);
      // Write the closure record into the project's Drive folder as evidence.
      driveWriteFile(t.projectId, `${todayStr()}_closure_${String(t.title).slice(0, 40).replace(/[^\w\- ]/g, "").trim().replace(/\s+/g, "-")}.txt`,
        `Elecbits ODM — task closure record\nProject: ${t.projectId}\nTask: ${t.title}\nClosed: ${new Date().toISOString()}\nAI verdict: ${verdict.verdict} (${verdict.score}/10)\nFeedback: ${verdict.feedback}\n\nWork log\n  What was done: ${work.whatDone || "—"}\n  File produced: ${work.fileName || "—"}\n  Stored at: ${work.fileLocation || "—"}\n\nVerification Q&A\n${qs.map((x, i) => `Q${i + 1}: ${x.q}\nA${i + 1}: ${x.a || "(no answer)"}`).join("\n")}\n`
      ).then((r) => { if (r === true) sheetSync(`${pmPath(t.projectId)}`, `Closure record written to Drive`); });
    }
    applyEsc();
    toast(`Task closed — ${verdict.score}/10`, "green");
    onClose();
  };
  const EscBox = (
    <div style={{ marginTop: 16, border: "1px dashed var(--bdr2)", borderRadius: 10, padding: "11px 13px", background: "var(--s2)" }}>
      <label style={{ display: "flex", alignItems: "center", gap: 9, cursor: "pointer", fontSize: 13, fontWeight: 600 }}>
        <input type="checkbox" checked={esc} onChange={(e) => setEsc(e.target.checked)} />
        <Shield size={14} style={{ color: "var(--purple)" }} /> Shall I escalate this to Shreya?
      </label>
      {esc && <input className="inp" style={{ marginTop: 8 }} placeholder="One line on why this needs the Dept Head" value={escNote} onChange={(e) => setEscNote(e.target.value)} />}
      <div style={{ fontSize: 11, color: "var(--txt3)", marginTop: 6 }}>Escalations are tracked in the KPI block — fewer is better, but a needed escalation beats a silently stuck task.</div>
    </div>
  );
  return (
    <Modal title={`Close: ${t.title}`} sub={`${t.projectId || "unlinked"} · the AI gate protects closure quality`} onClose={onClose} width={680}>
      {phase === "confirm" && (
        <div className="fade">
          <div style={{ fontWeight: 700, fontSize: 14.5, marginBottom: 4 }}>Did you actually finish this task?</div>
          <div style={{ fontSize: 12.5, color: "var(--txt2)", marginBottom: 13 }}>Straight answers keep the chain honest — branching an unfinished task is respected, fake-closing it is not.</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
            <ChoiceCard icon={CheckCircle2} title="Yes — fully done" sub="Run the AI verification questions and close it properly" onClick={genQuestions} />
            <ChoiceCard icon={GitBranch} title="Partially — some of it remains" sub="AI proposes sub-tasks for the rest; a story goes back to today's scrum" onClick={() => suggestBranch("partially completed — remaining work must be split out")} />
            <ChoiceCard icon={AlertTriangle} title="Blocked — can't proceed" sub="Describe the blocker; branch it and/or escalate" onClick={() => suggestBranch("")} />
          </div>
          {EscBox}
        </div>
      )}
      {phase === "questions" && (
        <div className="fade">
          {qBusy ? <div style={{ display: "flex", gap: 9, alignItems: "center", color: "var(--txt2)", padding: "20px 0" }}><Loader2 className="spin" size={16} /> Reading the task scope and your work log, preparing verification questions…</div> : (<>
            <div style={{ fontSize: 12.5, color: "var(--txt2)", marginBottom: 12 }}>Answer specifically — file names, paths, how you verified. Vague answers fail the gate.</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {qs.map((x, i) => (
                <div key={i}>
                  <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 6, display: "flex", gap: 8 }}><Bot size={15} style={{ color: "var(--acc)", flexShrink: 0, marginTop: 1 }} /> {x.q}</div>
                  <textarea className="inp" rows={2} value={x.a} onChange={(e) => setQs((q) => q.map((y, j) => (j === i ? { ...y, a: e.target.value } : y)))} />
                </div>
              ))}
            </div>
            <div style={{ marginTop: 14 }}><Btn icon={vBusy ? Loader2 : Bot} disabled={vBusy || qs.some((x) => !x.a.trim())} onClick={verify}>{vBusy ? "Verifying…" : "Verify with AI"}</Btn></div>
          </>)}
          {EscBox}
        </div>
      )}
      {phase === "verdict" && verdict && (
        <div className="fade">
          <div style={{ border: `1px solid ${verdict.verdict === "pass" ? "var(--green)" : "var(--red)"}`, background: "color-mix(in srgb, " + (verdict.verdict === "pass" ? "var(--green)" : "var(--red)") + " 8%, transparent)", borderRadius: 12, padding: 15 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 9, fontWeight: 800, fontSize: 15, color: verdict.verdict === "pass" ? "var(--green)" : "var(--red)" }}>
              {verdict.verdict === "pass" ? <CheckCircle2 size={19} /> : <X size={19} />} {verdict.verdict === "pass" ? "PASS" : "NOT YET"} · {verdict.score}/10 {verdict.offline && <Pill color="var(--amber)">offline heuristic</Pill>}
            </div>
            <div style={{ fontSize: 13, marginTop: 7, lineHeight: 1.55 }}>{verdict.feedback}</div>
          </div>
          <div style={{ display: "flex", gap: 10, marginTop: 14, flexWrap: "wrap" }}>
            {verdict.verdict === "pass" ? (
              <Btn kind="green" icon={CheckCircle2} onClick={closePass}>Confirm & close task</Btn>
            ) : (<>
              <Btn kind="ghost" onClick={() => { finalize({ status: "in-progress", lastFeedback: verdict.feedback, work }); toast("Kept open — feedback saved on the task", "amber"); onClose(); }}>Keep open · revise work</Btn>
              <Btn icon={GitBranch} onClick={() => { if (verdict.subtasks?.length) setRows(verdict.subtasks.map((s) => ({ title: s.title, assigneeId: t.assigneeId || "", timebox: s.timeboxMinutes || 60 }))); setPhase("branch"); }}>Branch sub-tasks</Btn>
            </>)}
          </div>
          {EscBox}
        </div>
      )}
      {phase === "branch" && (
        <div className="fade">
          <Field label="What's the blocker / what remains?"><textarea className="inp" rows={2} placeholder="e.g. Gerber has DRC violations on layer 3 — schematic needs re-verification" value={blocker} onChange={(e) => setBlocker(e.target.value)} /></Field>
          <div style={{ display: "flex", alignItems: "center", gap: 9, margin: "13px 0 8px" }}>
            <span style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".05em", color: "var(--txt2)" }}>Sub-tasks</span>
            {branchBusy ? <span style={{ fontSize: 12, color: "var(--txt2)", display: "flex", gap: 6, alignItems: "center" }}><Loader2 className="spin" size={13} /> AI drafting…</span> : <button style={{ background: "none", border: "none", color: "var(--acc)", fontSize: 12, cursor: "pointer", textDecoration: "underline" }} onClick={() => suggestBranch(blocker)}>AI re-suggest from blocker</button>}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {rows.map((r, i) => (
              <div key={i} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <input className="inp" style={{ flex: 1, minWidth: 180 }} placeholder="Sub-task title" value={r.title} onChange={(e) => setRows((rs) => rs.map((y, j) => (j === i ? { ...y, title: e.target.value } : y)))} />
                <select className="inp" style={{ width: 130 }} value={r.assigneeId} onChange={(e) => setRows((rs) => rs.map((y, j) => (j === i ? { ...y, assigneeId: e.target.value } : y)))}>
                  <option value="">— who —</option>
                  {users.filter((u) => u.role !== "superadmin").map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                </select>
                <input type="number" min="10" step="10" className="inp" style={{ width: 82, fontFamily: MONO }} value={r.timebox} onChange={(e) => setRows((rs) => rs.map((y, j) => (j === i ? { ...y, timebox: +e.target.value } : y)))} />
                <span style={{ fontSize: 11, color: "var(--txt3)" }}>min</span>
                <button style={{ background: "none", border: "none", color: "var(--txt3)", cursor: "pointer" }} onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}><Trash2 size={14} /></button>
              </div>
            ))}
          </div>
          <button style={{ background: "none", border: "none", color: "var(--acc)", fontSize: 12.5, cursor: "pointer", marginTop: 8, display: "flex", gap: 5, alignItems: "center" }} onClick={() => setRows((rs) => [...rs, { title: "", assigneeId: t.assigneeId || "", timebox: 60 }])}><Plus size={13} /> add row</button>
          <div style={{ marginTop: 13 }}><Btn icon={GitBranch} onClick={createBranch}>Create sub-tasks + write story to Scrum</Btn></div>
          {EscBox}
        </div>
      )}
    </Modal>
  );
}

/* ═══ RESOURCES — team view · resource planning · efficiency ═════════════
   Carried from the Elecbits PMS Resources module, driven by this tool's data:
   the roster, each project's team + timeline, and the task system.          */
const DEPT_OF = { jr_hw: "Hardware", sr_hw: "Hardware", jr_fw: "Firmware", sr_fw: "Firmware", jr_pm: "Project Management", sr_pm: "Project Management", sc: "Supply Chain", ind_design: "Industrial Design", sol_arch: "Solution Architecture", admin: "Management", tester: "Testing", devops: "DevOps", soldering: "Soldering & Testing" };
const CAP_OF = { sr_pm: 6, sr_hw: 6, sr_fw: 6, sol_arch: 6, ind_design: 6, admin: 6, jr_pm: 3, jr_hw: 3, jr_fw: 3, sc: 3, tester: 3, devops: 6, soldering: 3 };
/* Role catalogue for Add/Edit Resource — mirrors the Elecbits PMS resource roles. */
const RESOURCE_ROLES = [
  { key: "sr_hw", label: "Sr. Hardware", tier: "Senior", dept: "Hardware", cap: 6, skills: ["PCB Designing", "Schematic Design", "Altium Designer", "KiCad", "Hardware Debugging", "Signal Integrity", "EMI/EMC"] },
  { key: "sr_fw", label: "Sr. Firmware", tier: "Senior", dept: "Firmware", cap: 6, skills: ["Embedded C/C++", "RTOS", "ESP-IDF", "OTA / Bootloaders", "BLE/Wi-Fi Stacks", "Driver Development"] },
  { key: "sr_pm", label: "Senior PM", tier: "Senior", dept: "Project Management", cap: 6, skills: ["Project Planning", "Risk Management", "Client Communication", "Gantt & Milestones"] },
  { key: "jr_hw", label: "Jr. Hardware", tier: "Junior", dept: "Hardware", cap: 3, skills: ["PCB Designing", "Schematic Design", "Altium Designer", "KiCad", "Hardware Debugging", "Component Selection"] },
  { key: "jr_fw", label: "Jr. Firmware", tier: "Junior", dept: "Firmware", cap: 3, skills: ["Embedded C", "Arduino/ESP32", "Peripheral Drivers", "Debugging", "Unit Testing"] },
  { key: "tester", label: "Tester", tier: "Junior", dept: "Testing", cap: 3, skills: ["Test Planning", "Functional Testing", "Test Reports", "Compliance Pre-checks"] },
  { key: "ind_design", label: "Industrial Design", tier: "Junior", dept: "Industrial Design", cap: 6, skills: ["Enclosure Design", "3D Printing", "CAD (Fusion/SolidWorks)", "DFM"] },
  { key: "jr_pm", label: "Junior PM", tier: "Junior", dept: "Project Management", cap: 3, skills: ["Task Tracking", "Standups & Scrum", "Client Updates", "Documentation"] },
  { key: "soldering", label: "Soldering & Testing", tier: "Junior", dept: "Soldering & Testing", cap: 3, skills: ["SMD Soldering", "Rework", "Board Bring-up", "Continuity Testing"] },
  { key: "sol_arch", label: "Solution Architects", tier: "Shared", dept: "Solution Architecture", cap: 6, skills: ["System Architecture", "Tech Evaluation", "Cost Optimisation"] },
  { key: "devops", label: "DevOps", tier: "Shared", dept: "DevOps", cap: 6, skills: ["CI/CD", "Cloud Infra", "Monitoring"] },
  { key: "sc", label: "Supply Chain", tier: "Shared", dept: "Supply Chain", cap: 3, skills: ["Sourcing", "BoM Costing", "Vendor Management", "Logistics"] },
];
const rrInfo = (key) => RESOURCE_ROLES.find((r) => r.key === key);
const DEPT_LIST = ["Hardware", "Firmware", "Industrial Design", "Testing", "Project Management", "Supply Chain", "DevOps", "Solution Architecture", "Soldering & Testing"];
const LOGIN_TYPES = [["superadmin", "Super Admin"], ["pm", "Project Manager"], ["engineer", "Developer"]];
const PROJECT_TYPES = [["engineering", "Engineering Services"], ["elecbits_product", "Elecbits Product"], ["modifier", "Modifier"]];
const projWindow = (p) => ({ start: p.startDate || (p.createdAt || "").slice(0, 10), end: p.deadline || "9999-12-31" });

function ResourcesModule() {
  const { users, projects, tasks, me, toast } = useCtx();
  const my = users.find((u) => u.id === me);
  const isAdmin = ["superadmin", "dept_head"].includes(my?.role);
  const [tab, setTab] = useState("team");
  const [q, setQ] = useState("");
  const [roleF, setRoleF] = useState("all");
  const [deptF, setDeptF] = useState("all");
  const [avFrom, setAvFrom] = useState(todayStr());
  const [avTo, setAvTo] = useState(() => { const d = new Date(); d.setMonth(d.getMonth() + 2); return d.toISOString().slice(0, 10); });
  const [person, setPerson] = useState(null);
  const [resModal, setResModal] = useState(null); // {mode:"add"} | {mode:"edit", user}
  const today = todayStr();

  const members = users.filter((u) => u.id !== "u-admin");
  const deptOf = (u) => u.dept || DEPT_OF[u.resourceRole] || "—";
  const capOf = (u) => u.maxProjects || CAP_OF[u.resourceRole] || 3;
  const assignedProjs = (uid) => projects.filter((p) => (p.team || []).some((t) => t.userId === uid));
  const activeProjs = (uid) => assignedProjs(uid).filter((p) => p.status !== "Completed" && projWindow(p).end >= today);
  const roles = UNIQ_RR(members);
  const depts = [...new Set(members.map(deptOf).filter((d) => d !== "—"))];
  // Free-text search across the things you'd actually look someone up by:
  // name, email, title and their role/function label.
  const needle = q.trim().toLowerCase();
  const matchesQ = (u) => !needle || [u.name, u.email, u.title, ROLE_TITLE[u.resourceRole] || u.resourceRole, deptOf(u)]
    .some((v) => String(v || "").toLowerCase().includes(needle));
  const filtered = members.filter((u) => (roleF === "all" || u.resourceRole === roleF) && (deptF === "all" || deptOf(u) === deptF) && matchesQ(u));

  const statusOf = (u) => { const a = activeProjs(u.id).length, cap = capOf(u); return a >= cap ? ["At Capacity", "var(--red)"] : a ? ["Deployed", "var(--amber)"] : ["Available", "var(--green)"]; };

  const TABS = [["team", "Team View", Users], ["planning", "Resource Planning", Calendar], ["efficiency", "Efficiency", Gauge]];
  const th = { textAlign: "left", padding: "11px 14px", fontSize: 10.5, fontWeight: 700, color: "var(--txt2)", textTransform: "uppercase", letterSpacing: ".05em", whiteSpace: "nowrap" };
  const td = { padding: "12px 14px", fontSize: 12.5, verticalAlign: "middle" };
  const NameCell = ({ u }) => (
    <button onClick={() => setPerson(u)} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--txt)", display: "flex", alignItems: "center", gap: 9, padding: 0, fontSize: 13, fontWeight: 600, textAlign: "left" }}>
      <AvatarDot user={u} size={30} />
      <span style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
        <span>{u.name}</span>
        {/* Somebody a PM added who has not made their login yet. Saying so here
            is the difference between "it didn't save" and "they haven't joined". */}
        {supabaseEnabled && !u.authId && (
          <span style={{ fontSize: 10, color: "var(--amber)", fontWeight: 600 }}>
            {u.email ? `awaiting sign-up · ${u.email}` : "awaiting sign-up — no email on file"}
          </span>
        )}
      </span>
    </button>
  );
  /* Nobody is emailed automatically, so the admin has to tell them. Hand over
     the exact words — with the exact address — rather than leaving them to
     retype it and mistype it. */
  const InviteBtn = ({ u }) => {
    const [done, setDone] = useState(false);
    if (!supabaseEnabled || u.authId || !u.email) return null;
    const text = `You're set up on the Elecbits ODM PMS as ${u.title || "team"}.\n\n`
      + `1. Open ${typeof window !== "undefined" ? window.location.origin : ""}\n`
      + `2. Sign in with exactly this email: ${u.email}\n`
      + `3. Pick any password — the account is created the first time you press Continue.\n\n`
      + `Use that email exactly, or the app won't know it's you.`;
    return (
      <button title="Copy the joining instructions for this person"
        onClick={(e) => { e.stopPropagation(); navigator.clipboard?.writeText(text).then(() => { setDone(true); toast(`Invite for ${u.name} copied — paste it to them`, "green"); setTimeout(() => setDone(false), 2500); }).catch(() => toast("Couldn't reach the clipboard", "amber")); }}
        style={{ background: "none", border: "1px solid var(--bdr)", borderRadius: 7, color: done ? "var(--green)" : "var(--acc)", cursor: "pointer", padding: "6px 9px", display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11.5, fontWeight: 600 }}>
        {done ? <CheckCircle2 size={13} /> : <Send size={13} />} {done ? "Copied" : "Invite"}
      </button>
    );
  };
  const ProjCell = ({ uid, rangeFrom, rangeTo }) => {
    let list = assignedProjs(uid);
    if (rangeFrom) list = list.filter((p) => { const w = projWindow(p); return w.start <= rangeTo && w.end >= rangeFrom; });
    if (!list.length) return <span style={{ color: "var(--txt3)" }}>{rangeFrom ? "None in range" : "None"}</span>;
    const act = activeProjs(uid);
    return list.map((p) => {
      const w = projWindow(p); const on = act.some((x) => x.id === p.id);
      return (
        <div key={p.id} style={{ marginBottom: 5, opacity: on ? 1 : 0.55 }}>
          <div style={{ fontWeight: 600 }}>{p.name}{!on && <span style={{ fontSize: 10.5, color: "var(--txt3)", marginLeft: 6, fontWeight: 500 }}>(ended)</span>}</div>
          <div style={{ fontSize: 10.5, color: "var(--txt2)", fontFamily: MONO, marginTop: 1 }}>{fmtDate(w.start)} – {fmtDate(p.deadline)}</div>
        </div>
      );
    });
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div className="card" style={{ padding: "0 16px", display: "flex", alignItems: "center", gap: 2, flexWrap: "wrap" }}>
        {TABS.map(([k, l, Ic]) => (
          <button key={k} onClick={() => setTab(k)} style={{ display: "flex", alignItems: "center", gap: 7, padding: "13px 15px", background: "none", border: "none", borderBottom: `2px solid ${tab === k ? "var(--acc)" : "transparent"}`, color: tab === k ? "var(--acc)" : "var(--txt2)", fontWeight: tab === k ? 700 : 600, fontSize: 13, cursor: "pointer", transition: "all .15s" }}>
            <Ic size={15} /> {l}
          </button>
        ))}
        <div style={{ marginLeft: "auto", position: "relative", display: "flex", alignItems: "center" }}>
          <Search size={14} style={{ position: "absolute", left: 10, color: "var(--txt3)", pointerEvents: "none" }} />
          <input className="inp" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search people…"
            aria-label="Search resources"
            style={{ width: 220, padding: "8px 28px 8px 30px", fontSize: 12.5 }} />
          {q && <button onClick={() => setQ("")} title="Clear search" aria-label="Clear search"
            style={{ position: "absolute", right: 8, background: "none", border: "none", cursor: "pointer", color: "var(--txt3)", display: "flex", padding: 0 }}><X size={14} /></button>}
        </div>
        <span style={{ fontSize: 12, color: "var(--txt2)", padding: "8px 0 8px 12px" }}><b style={{ color: "var(--txt)" }}>{filtered.length}</b> resource{filtered.length !== 1 ? "s" : ""}</span>
        {isAdmin && <Btn small icon={Plus} onClick={() => setResModal({ mode: "add" })} style={{ margin: "8px 0 8px 10px" }}>Add Resource</Btn>}
      </div>

      {(tab === "team" || tab === "planning") && (
        <div className="card" style={{ padding: 14, display: "flex", alignItems: "flex-end", gap: 12, flexWrap: "wrap" }}>
          <Field label="Role"><select className="inp" style={{ width: 190 }} value={roleF} onChange={(e) => setRoleF(e.target.value)}><option value="all">All Roles</option>{roles.map((r) => <option key={r} value={r}>{ROLE_TITLE[r] || r}</option>)}</select></Field>
          <Field label="Department"><select className="inp" style={{ width: 190 }} value={deptF} onChange={(e) => setDeptF(e.target.value)}><option value="all">All Departments</option>{depts.map((d) => <option key={d} value={d}>{d}</option>)}</select></Field>
          {tab === "planning" && (<>
            <Field label="Available from"><input type="date" className="inp" style={{ width: 155 }} value={avFrom} onChange={(e) => setAvFrom(e.target.value)} /></Field>
            <Field label="Available to"><input type="date" className="inp" style={{ width: 155 }} value={avTo} onChange={(e) => setAvTo(e.target.value)} /></Field>
          </>)}
        </div>
      )}

      {tab === "team" && (
        <div className="card" style={{ overflow: "hidden" }}>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead><tr style={{ borderBottom: "1px solid var(--bdr)", background: "var(--s2)" }}>
                <th style={th}>Name</th><th style={th}>Role</th><th style={th}>Dept</th><th style={th}>Projects</th><th style={th}>Open tasks</th><th style={{ ...th, textAlign: "center" }}>Cap</th><th style={th}>Status</th>{isAdmin && <th style={{ ...th, width: 70 }}>Actions</th>}
              </tr></thead>
              <tbody>
                {filtered.map((u) => {
                  const act = activeProjs(u.id).length; const cap = capOf(u);
                  const open = tasks.filter((t) => t.assigneeId === u.id && t.status !== "done").length;
                  const [sl, sc] = statusOf(u);
                  return (
                    <tr key={u.id} className="rowHover" style={{ borderBottom: "1px solid var(--bdr)" }}>
                      <td style={td}><NameCell u={u} /></td>
                      <td style={td}><Pill color="var(--acc)">{u.title}</Pill></td>
                      <td style={{ ...td, color: "var(--txt2)", fontWeight: 500 }}>{deptOf(u)}</td>
                      <td style={td}><ProjCell uid={u.id} /></td>
                      <td style={{ ...td, textAlign: "center", fontFamily: MONO, fontWeight: 600, color: open ? "var(--blue)" : "var(--txt3)" }}>{open}</td>
                      <td style={{ ...td, textAlign: "center", fontFamily: MONO, fontWeight: 700, color: act >= cap ? "var(--red)" : "var(--green)" }}>{act}/{cap}</td>
                      <td style={td}><Pill color={sc}>{sl}</Pill></td>
                      {isAdmin && <td style={{ ...td, whiteSpace: "nowrap" }}><InviteBtn u={u} /> <button title="Edit resource" onClick={() => setResModal({ mode: "edit", user: u })} style={{ background: "none", border: "1px solid var(--bdr)", borderRadius: 7, color: "var(--acc)", cursor: "pointer", padding: "6px 9px", display: "inline-flex" }}><Pencil size={13} /></button></td>}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === "planning" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div className="card" style={{ padding: "11px 15px", fontSize: 12.5, color: "var(--txt2)" }}>
            Showing availability in the period <b style={{ color: "var(--acc)" }}>{fmtDate(avFrom)}</b> → <b style={{ color: "var(--acc)" }}>{fmtDate(avTo)}</b>.
          </div>
          <div className="card" style={{ overflow: "hidden" }}>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead><tr style={{ borderBottom: "1px solid var(--bdr)", background: "var(--s2)" }}>
                  <th style={th}>Resource</th><th style={th}>Role</th><th style={th}>Availability in period</th><th style={th}>Deployed projects</th><th style={th}>Status</th>
                </tr></thead>
                <tbody>
                  {filtered.map((u) => {
                    const inRange = assignedProjs(u.id).filter((p) => { const w = projWindow(p); return p.status !== "Completed" && w.start <= avTo && w.end >= avFrom; });
                    const busy = inRange.length >= capOf(u);
                    const label = busy ? "At capacity in this period" : inRange.length ? "Partially available — check deployments" : `Fully free ${fmtDate(avFrom)} → ${fmtDate(avTo)}`;
                    return (
                      <tr key={u.id} className="rowHover" style={{ borderBottom: "1px solid var(--bdr)" }}>
                        <td style={td}><NameCell u={u} /></td>
                        <td style={td}><Pill color="var(--acc)">{u.title}</Pill></td>
                        <td style={{ ...td, fontWeight: 600, color: busy ? "var(--red)" : inRange.length ? "var(--amber)" : "var(--green)" }}>{label}</td>
                        <td style={td}><ProjCell uid={u.id} rangeFrom={avFrom} rangeTo={avTo} /></td>
                        <td style={td}><Pill color={busy ? "var(--red)" : inRange.length ? "var(--amber)" : "var(--green)"}>{busy ? "At Capacity" : inRange.length ? "Partially Deployed" : "Available"}</Pill></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {tab === "efficiency" && (
        <div className="card" style={{ overflow: "hidden" }}>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead><tr style={{ borderBottom: "1px solid var(--bdr)", background: "var(--s2)" }}>
                <th style={th}>Name</th><th style={th}>Role</th><th style={{ ...th, textAlign: "center" }}>Projects</th><th style={{ ...th, textAlign: "center" }}>Tasks</th><th style={{ ...th, textAlign: "center" }}>Done</th><th style={{ ...th, textAlign: "center" }}>AI-verified</th><th style={{ ...th, textAlign: "center" }}>Blocked</th><th style={{ ...th, width: 150 }}>Completion</th>
              </tr></thead>
              <tbody>
                {members.map((u) => {
                  const mine = tasks.filter((t) => t.assigneeId === u.id);
                  const done = mine.filter((t) => t.status === "done");
                  const blocked = mine.filter((t) => t.status === "blocked").length;
                  const ai = done.filter((t) => t.aiVerification).length;
                  const pct = mine.length ? Math.round((done.length / mine.length) * 100) : 0;
                  return (
                    <tr key={u.id} className="rowHover" style={{ borderBottom: "1px solid var(--bdr)" }}>
                      <td style={td}><NameCell u={u} /></td>
                      <td style={td}><Pill color="var(--acc)">{u.title}</Pill></td>
                      <td style={{ ...td, textAlign: "center", fontFamily: MONO, fontWeight: 600 }}>{assignedProjs(u.id).length}</td>
                      <td style={{ ...td, textAlign: "center", fontFamily: MONO, fontWeight: 600 }}>{mine.length}</td>
                      <td style={{ ...td, textAlign: "center", fontFamily: MONO, fontWeight: 700, color: "var(--green)" }}>{done.length}</td>
                      <td style={{ ...td, textAlign: "center", fontFamily: MONO, fontWeight: 700, color: ai ? "var(--purple)" : "var(--txt3)" }}>{ai}</td>
                      <td style={{ ...td, textAlign: "center", fontFamily: MONO, fontWeight: 700, color: blocked ? "var(--red)" : "var(--txt3)" }}>{blocked}</td>
                      <td style={td}><div style={{ display: "flex", alignItems: "center", gap: 8 }}><Progress pct={pct} color={pct >= 70 ? "var(--green)" : pct >= 40 ? "var(--amber)" : "var(--acc)"} /><span style={{ fontFamily: MONO, fontSize: 11, color: "var(--txt2)", width: 34, textAlign: "right" }}>{pct}%</span></div></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {person && (
        <Modal title={person.name} sub={`${person.title}${person.email ? " · " + person.email : ""}`} onClose={() => setPerson(null)} width={520}>
          <div style={{ display: "flex", alignItems: "center", gap: 13, marginBottom: 16, padding: "14px 16px", background: "var(--s2)", borderRadius: 11, border: "1px solid var(--bdr)" }}>
            <AvatarDot user={person} size={48} />
            <div>
              <div style={{ fontWeight: 800, fontSize: 15 }}>{person.name}</div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 5 }}>
                <Pill color="var(--acc)">{person.title}</Pill>
                <Pill color="var(--txt2)">{deptOf(person)}</Pill>
                <Pill color={statusOf(person)[1]}>{statusOf(person)[0]}</Pill>
              </div>
            </div>
          </div>
          <SectionTitle icon={FolderPlus}>Deployed projects</SectionTitle>
          {assignedProjs(person.id).length === 0 ? <div style={{ fontSize: 12.5, color: "var(--txt2)" }}>Not on any project yet.</div> : assignedProjs(person.id).map((p) => {
            const w = projWindow(p); const slot = (p.team || []).find((t) => t.userId === person.id)?.slot;
            const on = p.status !== "Completed" && w.end >= today;
            return (
              <div key={p.id} style={{ padding: "11px 13px", borderRadius: 10, marginBottom: 8, border: `1px solid ${on ? "color-mix(in srgb, var(--acc) 35%, transparent)" : "var(--bdr)"}` }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "flex-start" }}>
                  <div><div style={{ fontWeight: 700, fontSize: 13 }}>{p.name}</div><div style={{ fontSize: 11.5, color: "var(--txt2)", marginTop: 2 }}>{slot}</div></div>
                  {on && <Pill color="var(--acc)">Active</Pill>}
                </div>
                <div style={{ fontSize: 12, marginTop: 7, color: "var(--txt2)" }}><span style={{ color: "var(--txt3)" }}>Period: </span>{fmtDate(w.start)} → {fmtDate(p.deadline)}</div>
              </div>
            );
          })}
          <SectionTitle icon={ListChecks}>Open tasks</SectionTitle>
          {tasks.filter((t) => t.assigneeId === person.id && t.status !== "done").length === 0 ? <div style={{ fontSize: 12.5, color: "var(--txt2)" }}>No open tasks.</div> : tasks.filter((t) => t.assigneeId === person.id && t.status !== "done").map((t) => (
            <div key={t.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 11px", borderRadius: 9, marginBottom: 6, border: "1px solid var(--bdr)", fontSize: 12.5 }}>
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: STATUS_DOT[t.status], flexShrink: 0 }} />
              <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.title}</span>
              {t.projectId && <Pill color="var(--blue)" style={{ fontFamily: MONO }}>{t.projectId}</Pill>}
            </div>
          ))}
        </Modal>
      )}
      {resModal && <ResourceModal mode={resModal.mode} user={resModal.user} onClose={() => setResModal(null)} />}
    </div>
  );
}
const UNIQ_RR = (users) => [...new Set(users.map((u) => u.resourceRole).filter(Boolean))];

/* Add / Edit Resource — mirrors the Elecbits PMS "Add New Resource" modal:
   name, email, department, grouped role/function, login type, role-based
   skills, project type, live preview; edit mode adds a confirmed Remove. */
function ResourceModal({ mode, user, onClose }) {
  const { users, addUser, updateUser, removeUser, provisionLogin, toast } = useCtx();
  const [pwd, setPwd] = useState("");
  const [pwdBusy, setPwdBusy] = useState(false);
  const [pwdErr, setPwdErr] = useState("");
  const editing = mode === "edit";
  const [name, setName] = useState(user?.name || "");
  const [email, setEmail] = useState(user?.email || "");
  const [dept, setDept] = useState(user ? (user.dept || rrInfo(user.resourceRole)?.dept || "") : "");
  const [rr, setRr] = useState(user?.resourceRole || "jr_hw");
  const [login, setLogin] = useState(user?.role === "dept_head" ? "superadmin" : (user?.role || "engineer"));
  const [skills, setSkills] = useState(user?.skills?.length ? user.skills : (rrInfo(user?.resourceRole || "jr_hw")?.skills || []));
  const [ptype, setPtype] = useState((user?.projectTags || ["engineering"])[0]);
  const [confirmDel, setConfirmDel] = useState(false);
  const info = rrInfo(rr);
  const roleOptions = dept ? RESOURCE_ROLES.filter((r) => r.dept === dept) : RESOURCE_ROLES;
  const pickDept = (d) => {
    setDept(d);
    const opts = d ? RESOURCE_ROLES.filter((r) => r.dept === d) : RESOURCE_ROLES;
    if (d && !opts.some((o) => o.key === rr)) { setRr(opts[0].key); setSkills(opts[0].skills); }
  };
  const pickRr = (k) => { setRr(k); setSkills(rrInfo(k)?.skills || []); };
  const toggleSkill = (s) => setSkills((x) => (x.includes(s) ? x.filter((y) => y !== s) : [...x, s]));
  const loginLabel = LOGIN_TYPES.find(([k]) => k === login)?.[1] || login;
  /* The email is the join between this roster entry and the login the person
     will make, so it has to be right and it has to be there. */
  const addr = email.trim().toLowerCase();
  const taken = users.find((u) => u.id !== user?.id && (u.email || "").toLowerCase() === addr && addr);
  const nearMiss = addr && !taken ? domainTypo(addr, users.filter((u) => u.id !== user?.id)) : "";
  const emailProblem = !addr ? "Needed — it is how they sign in and how the app knows this row is them."
    : !emailShapeOk(addr) ? "That doesn't look like an email address."
    : taken ? `${taken.name} is already on the roster with this email.` : "";

  const save = async () => {
    if (!name.trim() || emailProblem || pwdBusy) return;
    if (pwd && pwd.length < 8) { setPwdErr("At least 8 characters — or leave it blank and they sign up themselves."); return; }
    const u = {
      id: user?.id || uuid(), name: name.trim(), email: addr,
      role: login, title: info?.label ? (ROLE_TITLE[rr] || info.label) : "Team",
      resourceRole: rr, dept: dept || info?.dept || "", skills, projectTags: [ptype],
      maxProjects: info?.cap || 3, color: user?.color || _PALETTE[users.length % _PALETTE.length],
    };
    if (editing) updateUser(u); else addUser(u);
    if (!pwd) { onClose(); return; }
    // The roster entry is saved either way; the login is a second, separate
    // step, and a failure keeps the modal open so it can be retried.
    setPwdBusy(true); setPwdErr("");
    const res = await provisionLogin(addr, pwd, name.trim());
    setPwdBusy(false);
    if (res === "") { toast(`Login ready — ${addr} can sign in now`, "green"); onClose(); }
    else if (res === "reset") { toast(`Password reset — ${addr} signs in with the new one`, "green"); onClose(); }
    else setPwdErr(res);
  };
  return (
    <Modal title={editing ? `Edit ${user?.name}` : "Add New Resource"} onClose={onClose} width={560}
      footer={<>
        {editing && (confirmDel ? (
          <div style={{ marginRight: "auto", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span style={{ fontSize: 12, color: "var(--red)", fontWeight: 600 }}>Remove {user?.name}? Unassigns them from all projects.</span>
            <Btn small kind="danger" icon={Trash2} onClick={() => { removeUser(user.id, user.name); onClose(); }}>Yes, remove</Btn>
            <Btn small kind="ghost" onClick={() => setConfirmDel(false)}>Keep</Btn>
          </div>
        ) : (
          <Btn small kind="ghost" icon={Trash2} style={{ marginRight: "auto", color: "var(--red)", borderColor: "color-mix(in srgb, var(--red) 40%, transparent)" }} onClick={() => setConfirmDel(true)}>Remove</Btn>
        ))}
        <Btn kind="ghost" onClick={onClose}>Cancel</Btn>
        <Btn kind="green" icon={CheckCircle2} disabled={!name.trim() || !!emailProblem || pwdBusy} onClick={save}>{pwdBusy ? "Creating login…" : editing ? "Save changes" : "Add Resource"}</Btn>
      </>}>
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <Field label="Full name" req><input className="inp" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Raj Patel" /></Field>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <Field label="Email" req>
            <input className="inp" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="raj@elecbits.in"
              style={emailProblem ? { borderColor: "var(--red)" } : undefined} />
            {emailProblem && <span style={{ fontSize: 11, color: "var(--red)", fontWeight: 600, marginTop: 4, display: "block", lineHeight: 1.45 }}>{emailProblem}</span>}
            {!emailProblem && nearMiss && (
              <span style={{ fontSize: 11, color: "var(--amber)", fontWeight: 600, marginTop: 4, display: "block", lineHeight: 1.45 }}>
                Nobody else uses <span style={{ fontFamily: MONO }}>@{domainOf(addr)}</span>.{" "}
                <button type="button" onClick={() => setEmail(`${addr.split("@")[0]}@${nearMiss}`)}
                  style={{ background: "none", border: "none", padding: 0, color: "var(--acc)", cursor: "pointer", font: "inherit", textDecoration: "underline" }}>
                  Did you mean @{nearMiss}?
                </button>
              </span>
            )}
          </Field>
          <Field label="Department">
            <select className="inp" value={dept} onChange={(e) => pickDept(e.target.value)}>
              <option value="">— Select Department —</option>
              {DEPT_LIST.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          </Field>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <Field label="Role / Function">
            <select className="inp" value={rr} onChange={(e) => pickRr(e.target.value)}>
              {["Senior", "Junior", "Shared"].map((tier) => {
                const opts = roleOptions.filter((r) => r.tier === tier);
                return opts.length ? <optgroup key={tier} label={tier}>{opts.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}</optgroup> : null;
              })}
            </select>
          </Field>
          <Field label="Login type">
            <select className="inp" value={login} onChange={(e) => setLogin(e.target.value)}>
              {LOGIN_TYPES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </Field>
        </div>
        {supabaseEnabled && (
          <Field label={editing ? "Reset their password (optional)" : "Set their password (optional)"}>
            <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
              <div style={{ flex: 1 }}>
                <PasswordInput value={pwd} onChange={(v) => { setPwd(v); setPwdErr(""); }} placeholder="leave blank — they sign up themselves" autoComplete="new-password" />
              </div>
              <Btn small kind="ghost" onClick={() => { setPwd(genPassword()); setPwdErr(""); }} title="Generate a strong password">Generate</Btn>
            </div>
            {pwdErr
              ? <span style={{ fontSize: 11, color: "var(--red)", fontWeight: 600, marginTop: 5, display: "block", lineHeight: 1.5 }}>{pwdErr}</span>
              : <span style={{ fontSize: 11, color: "var(--txt3)", marginTop: 5, display: "block", lineHeight: 1.5 }}>
                  With a password set, their account works the moment you save — share it with them and they sign in at this URL.
                  {pwd ? " Copy it now; it is not shown again." : ""}
                </span>}
          </Field>
        )}
        <Field label="Skills — based on selected role">
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {(info?.skills || []).map((s) => <button key={s} style={chipS(skills.includes(s))} onClick={() => toggleSkill(s)}>{s}</button>)}
          </div>
        </Field>
        <Field label="Project type">
          <div style={{ display: "flex", gap: 7, flexWrap: "wrap" }}>
            {PROJECT_TYPES.map(([k, l]) => <button key={k} style={chipS(ptype === k)} onClick={() => setPtype(k)}>{ptype === k ? "● " : "○ "}{l}</button>)}
          </div>
        </Field>
        <div style={{ display: "flex", alignItems: "center", gap: 11, padding: "11px 14px", background: "var(--s2)", borderRadius: 10, border: "1px solid var(--bdr)" }}>
          <AvatarDot user={{ name: name || "?", color: user?.color || "var(--acc)" }} size={34} />
          <div>
            <div style={{ fontWeight: 700, fontSize: 13 }}>{name.trim() || "New Resource"}</div>
            <div style={{ fontSize: 11.5, color: "var(--txt2)", marginTop: 2 }}>{info?.label || "—"} · {loginLabel}{!editing && <span style={{ fontFamily: MONO }}> · pw: Elecbits@2026 (via setup script)</span>}</div>
          </div>
        </div>
      </div>
    </Modal>
  );
}

/* ═══ MODULE 4 — PERFORMANCE & TRAINING ══════════════════════════════════
   Side-to-side tab menu (KPI · Work update sheet · Training) in the
   Eb Sales OS style, daily calendar tracking on both KPI and work updates,
   and a Google-Docs-like open-ended page for the daily work update.     */
const wuDays = (n = 7) => [...Array(n)].map((_, i) => { const dd = new Date(Date.now() - (n - 1 - i) * 86400000); return { date: dd.toISOString().slice(0, 10), dow: dd.getDay(), label: dd.toLocaleDateString("en-IN", { weekday: "short" }), dnum: dd.getDate() }; });
const noteOf = (w) => w?.note ?? [w?.learnings, w?.wrong, w?.better].filter(Boolean).join("\n\n");

/* Contribution, on the person's own Performance page: what they suggested,
   what it saved, and where they sit against everyone else. */
function IdeasTab({ projects, users, me, isMgr, viewUserId, setViewUserId }) {
  const credit = momCredit(projects);
  const who = users.find((u) => u.id === (isMgr ? viewUserId : me));
  const mine = credit.find((c) => normId(c.name) === normId(who?.name || ""));
  const rank = mine ? credit.findIndex((c) => c === mine) + 1 : 0;
  const sessions = allMoms(projects).filter((m) => (m.ai?.ideas || []).some((i) => normId(i.by) === normId(who?.name || "")));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div className="card" style={{ padding: 16 }}>
        <SectionTitle icon={Lightbulb} right={isMgr && (
          <select className="inp" style={{ width: 190 }} value={viewUserId} onChange={(e) => setViewUserId(e.target.value)}>
            {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
        )}>{who?.name || "Contribution"}</SectionTitle>
        {!mine ? (
          <Empty icon={Lightbulb} title="No ideas credited yet" sub="Ideas are credited when a discussion is written up in a brainstorming session on a project — and only when the suggestion actually changed the approach, saved time or money, caught a risk, or lifted quality." />
        ) : (
          <>
            <div style={{ display: "flex", gap: 22, flexWrap: "wrap", marginBottom: 14 }}>
              <div><div style={{ fontSize: 30, fontWeight: 800, fontFamily: MONO, color: "var(--amber)", lineHeight: 1 }}>#{rank}</div><div style={{ fontSize: 11, color: "var(--txt2)", marginTop: 3 }}>of {credit.length} contributing</div></div>
              <div><div style={{ fontSize: 30, fontWeight: 800, fontFamily: MONO, color: "var(--acc)", lineHeight: 1 }}>{mine.count}</div><div style={{ fontSize: 11, color: "var(--txt2)", marginTop: 3 }}>ideas credited</div></div>
              <div><div style={{ fontSize: 30, fontWeight: 800, fontFamily: MONO, color: "var(--purple)", lineHeight: 1 }}>{mine.score}</div><div style={{ fontSize: 11, color: "var(--txt2)", marginTop: 3 }}>impact score</div></div>
              <div style={{ display: "flex", gap: 7, alignItems: "center", flexWrap: "wrap" }}>
                {Object.entries(mine.impacts).map(([k, n]) => <Pill key={k} color={impactOf(k).c}>{impactOf(k).label} {n}</Pill>)}
              </div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {sessions.slice(0, 8).map((m) => <MomCard key={m.id} m={m} showProject />)}
            </div>
          </>
        )}
      </div>
      <div className="card" style={{ padding: 16 }}>
        <SectionTitle icon={Award}>Across the team</SectionTitle>
        {credit.length ? <IdeaBoard credit={credit} /> : <div style={{ fontSize: 12.5, color: "var(--txt3)" }}>Nothing written up yet.</div>}
      </div>
    </div>
  );
}

function PerfModule() {
  const { users, me, projects, tasks, kpiLog, setKpiLog, workUpdates, setWorkUpdates, trainings, setTrainings, memory, toast } = useCtx();
  const my = users.find((u) => u.id === me);
  const isAdmin = ["superadmin", "dept_head"].includes(my?.role);
  const isMgr = isAdmin || my?.role === "pm";
  const [ptab, setPtab] = useState("kpi");
  const [date, setDate] = useState(todayStr());
  const [viewUserId, setViewUserId] = useState(me);
  const [assignOpen, setAssignOpen] = useState(false);
  useEffect(() => { setViewUserId(me); }, [me]);
  const pms = users.filter((u) => u.role === "pm");
  const shownPMs = isAdmin ? pms : my?.role === "pm" ? [my] : [];

  const metricsFor = (pmId, dt) => {
    const pmProjects = projects.filter((p) => (p.team || []).some((x) => x.userId === pmId && x.slot.startsWith("PM"))).map((p) => p.projectId);
    const inScope = (t) => pmProjects.includes(t.projectId) || t.createdBy === pmId;
    const dayTasks = tasks.filter((t) => t.date === dt && inScope(t));
    // KPIs are DERIVED from the tasks assigned for that day — never self-incremented.
    const isClientTask = (t) => /client|customer|communicat|\bquery\b|\bcall\b|email|quote|proposal|demo/i.test([t.title, ...(t.steps || [])].join(" "));
    const queries = dayTasks.filter(isClientTask).length;                       // customer/client tasks assigned today
    const done = dayTasks.filter((t) => t.status === "done");
    const decisions = dayTasks.filter((t) => t.createdBy === pmId || t.status === "done").length; // tasks the PM planned + tasks closed today
    const onTime = done.filter((t) => !t.endTime || (t.completedAt && new Date(t.completedAt) <= hmToDate(t.date, t.endTime))).length;
    const onTimePct = dayTasks.length ? Math.round((onTime / dayTasks.length) * 100) : null;
    const aiChecks = done.filter((t) => t.aiVerification).length;
    const escalations = tasks.filter((t) => t.escalated?.at?.slice(0, 10) === dt && inScope(t)).length;
    const alerts = [];
    if (queries < KPI_T.queries) alerts.push(`Customer queries ${queries}/${KPI_T.queries} min`);
    if (decisions < KPI_T.decisions) alerts.push(`Decisions ${decisions}/${KPI_T.decisions} min`);
    if (onTimePct !== null && onTimePct < KPI_T.onTime) alerts.push(`On-time ${onTimePct}% < ${KPI_T.onTime}%`);
    if (escalations > KPI_T.escalations) alerts.push(`${escalations} escalations to Shreya (max ${KPI_T.escalations})`);
    return { queries, decisions, onTimePct, aiChecks, escalations, dayTaskCount: dayTasks.length, alerts };
  };
  const TABS = [["kpi", "KPI tracking", Gauge], ["worklog", "Work update sheet", NotebookPen], ["ideas", "Ideas & contribution", Lightbulb], ["training", "Training", GraduationCap]];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div className="card" style={{ padding: "0 16px", display: "flex", alignItems: "center", gap: 2, flexWrap: "wrap" }}>
        {TABS.map(([k, l, Ic]) => (
          <button key={k} onClick={() => setPtab(k)} style={{ display: "flex", alignItems: "center", gap: 7, padding: "13px 15px", background: "none", border: "none", borderBottom: `2px solid ${ptab === k ? "var(--acc)" : "transparent"}`, color: ptab === k ? "var(--acc)" : "var(--txt2)", fontWeight: ptab === k ? 700 : 600, fontSize: 13, cursor: "pointer", transition: "all .15s" }}>
            <Ic size={15} /> {l}
          </button>
        ))}
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8, padding: "8px 0" }}>
          <Calendar size={14} style={{ color: "var(--txt3)" }} />
          <input type="date" className="inp" style={{ width: 158, padding: "6px 10px" }} value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
      </div>

      {ptab === "kpi" && <KpiTab shownPMs={shownPMs} date={date} setDate={setDate} metricsFor={metricsFor} me={me} isAdmin={isAdmin} tasks={tasks} />}
      {ptab === "worklog" && <WorklogTab date={date} setDate={setDate} viewUserId={viewUserId} setViewUserId={setViewUserId} isMgr={isMgr} />}
      {ptab === "ideas" && <IdeasTab projects={projects} users={users} me={me} isMgr={isMgr} viewUserId={viewUserId} setViewUserId={setViewUserId} />}
      {ptab === "training" && (
        <div className="card" style={{ padding: 16 }}>
          <SectionTitle icon={GraduationCap} right={isMgr && <Btn small icon={Plus} onClick={() => setAssignOpen(true)}>Assign training</Btn>}>Training</SectionTitle>
          <TrainingList isMgr={isMgr} />
        </div>
      )}
      {assignOpen && <AssignTraining onClose={() => setAssignOpen(false)} />}
    </div>
  );
}

function KpiTab({ shownPMs, date, setDate, metricsFor, me, isAdmin, tasks }) {
  const { users } = useCtx();
  const last7 = wuDays(7);
  return (
    <div className="card" style={{ padding: 16 }}>
      <SectionTitle icon={Gauge}>PM KPIs — daily, on the calendar</SectionTitle>
      <div style={{ fontSize: 12, color: "var(--txt2)", marginBottom: 13, lineHeight: 1.6 }}>{KPI_DEFS}</div>
      {shownPMs.length === 0 && <div style={{ fontSize: 12.5, color: "var(--txt2)" }}>KPIs are tracked per PM. Your own record still counts — {tasks.filter((t) => t.assigneeId === me && t.date === date && t.status === "done").length} of {tasks.filter((t) => t.assigneeId === me && t.date === date).length} of your tasks done on {fmtDate(date)}.</div>}
      <div style={{ display: "flex", flexDirection: "column", gap: 13 }}>
        {shownPMs.map((pm) => {
          const m = metricsFor(pm.id, date);
          const tiles = [
            ["Customer queries", m.queries, `from today's client tasks · min ${KPI_T.queries}`, m.queries >= KPI_T.queries],
            ["Decisions taken", m.decisions, `tasks planned + closed today · min ${KPI_T.decisions}`, m.decisions >= KPI_T.decisions],
            ["Team on-time", m.onTimePct === null ? "—" : m.onTimePct + "%", `target ≥ ${KPI_T.onTime}%`, m.onTimePct === null || m.onTimePct >= KPI_T.onTime],
            ["AI-checked closes", m.aiChecks, "every close through the gate", true],
            ["Escalations → Shreya", m.escalations, `max ${KPI_T.escalations} (fewer = better)`, m.escalations <= KPI_T.escalations],
          ];
          return (
            <div key={pm.id} style={{ border: "1px solid var(--bdr)", borderRadius: 12, overflow: "hidden" }}>
              {m.alerts.length > 0 && (
                <div style={{ background: "color-mix(in srgb, var(--red) 12%, transparent)", borderBottom: "1px solid var(--red)", padding: "9px 14px", display: "flex", gap: 9, alignItems: "center", color: "var(--red)", fontWeight: 700, fontSize: 12.5, flexWrap: "wrap" }}>
                  <AlertTriangle size={15} /> RED ALERT — {m.alerts.join(" · ")}
                </div>
              )}
              <div style={{ padding: 14 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12, flexWrap: "wrap" }}>
                  <AvatarDot user={pm} size={30} />
                  <div><div style={{ fontWeight: 700, fontSize: 13.5 }}>{pm.name}</div><div style={{ fontSize: 11.5, color: "var(--txt2)" }}>{pm.title} · {fmtDate(date)}</div></div>
                  <div style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
                    {last7.map((d) => { const md = metricsFor(pm.id, d.date); const active = md.queries + md.decisions + md.dayTaskCount > 0; return <button key={d.date} title={`${d.label} ${d.dnum} — click to open`} onClick={() => setDate(d.date)} style={{ width: 15, height: 15, borderRadius: 4, border: "none", cursor: "pointer", background: !active ? "var(--s3)" : md.alerts.length ? "var(--red)" : "var(--green)", opacity: d.date === date ? 1 : 0.7, outline: d.date === date ? "2px solid var(--acc)" : "none" }} />; })}
                  </div>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: 9 }}>
                  {tiles.map(([label, val, sub, ok]) => (
                    <div key={label} style={{ background: "var(--s2)", border: `1px solid ${ok ? "var(--bdr)" : "var(--red)"}`, borderRadius: 10, padding: "10px 12px" }}>
                      <div style={{ fontSize: 10.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".05em", color: "var(--txt2)" }}>{label}</div>
                      <div style={{ fontSize: 21, fontWeight: 800, fontFamily: MONO, color: ok ? "var(--txt)" : "var(--red)", margin: "3px 0 1px" }}>{val}</div>
                      <div style={{ fontSize: 10.5, color: "var(--txt3)" }}>{sub}</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ── Work update sheet — Eb Sales OS discipline strip + Google-Docs page ── */
function WorklogTab({ date, setDate, viewUserId, setViewUserId, isMgr }) {
  const { users, me, workUpdates, setWorkUpdates, memory, toast } = useCtx();
  const days = wuDays(7);
  const today = todayStr();
  const viewUser = users.find((u) => u.id === viewUserId) || users.find((u) => u.id === me);
  const entryFor = (userId, dt) => workUpdates.find((w) => w.userId === userId && w.date === dt);
  const entry = entryFor(viewUserId, date);
  const isSelf = viewUserId === me;
  const editable = isSelf && date === today;
  const [note, setNote] = useState("");
  const [wuBusy, setWuBusy] = useState(false);
  const taRef = useRef(null);
  useEffect(() => { const e = entryFor(viewUserId, date); setNote(e ? noteOf(e) : ""); requestAnimationFrame(() => { if (taRef.current) { taRef.current.style.height = "auto"; taRef.current.style.height = Math.max(360, taRef.current.scrollHeight) + "px"; } }); }, [viewUserId, date]); // eslint-disable-line
  const cellState = (userId, d) => { if (d.dow === 0) return "off"; if (entryFor(userId, d.date)) return "ok"; if (d.date === today) return "due"; if (d.date > today) return "future"; return "miss"; };
  const CELL_BG = { ok: "color-mix(in srgb, var(--green) 14%, transparent)", miss: "color-mix(in srgb, var(--red) 12%, transparent)", due: "color-mix(in srgb, var(--amber) 14%, transparent)", off: "var(--s2)", future: "var(--s2)" };
  const CellIcon = ({ s }) => s === "ok" ? <CheckCircle2 size={13} style={{ color: "var(--green)" }} /> : s === "miss" ? <X size={13} style={{ color: "var(--red)" }} /> : s === "due" ? <Clock size={13} style={{ color: "var(--amber)" }} /> : <span style={{ fontSize: 10, color: "var(--txt3)" }}>·</span>;
  const scoreColor = (s) => (s === null || s === undefined ? "var(--txt3)" : s >= 70 ? "var(--green)" : s >= 40 ? "var(--amber)" : "var(--red)");

  const submitWU = async () => {
    if (!note.trim()) return;
    setWuBusy(true);
    let scored = { score: null, feedback: "AI unreachable — stored without a score; resubmit later to score it.", kpiHits: [] };
    try { scored = await claude(alignPrompt({ note }, memory)); } catch (e) { }
    setWorkUpdates((x) => {
      const ex = x.find((w) => w.userId === me && w.date === date);
      const e = { id: ex ? ex.id : uid(), userId: me, date, note, ...scored, at: new Date().toISOString() };
      return ex ? x.map((w) => (w.id === ex.id ? e : w)) : [e, ...x];
    });
    setWuBusy(false);
    toast(scored.score !== null ? `Aligned ${scored.score}/100 with the KPI` : "Saved — unscored for now", scored.score !== null ? "green" : "amber");
  };

  const team = isMgr ? users.filter((u) => u.role !== "superadmin") : [];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div className="card" style={{ padding: 15 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: "var(--txt2)", textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 9 }}>{isSelf ? "Your" : viewUser?.name + "'s"} last 7 days — a red ✗ is a missed day, on record</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {days.map((d) => { const s = cellState(viewUserId, d); return (
            <button key={d.date} onClick={() => setDate(d.date)} style={{ width: 62, padding: "7px 4px", borderRadius: 9, border: `1.5px solid ${d.date === date ? "var(--acc)" : "var(--bdr)"}`, background: CELL_BG[s], cursor: "pointer", textAlign: "center" }}>
              <span style={{ display: "block", fontSize: 10.5, color: "var(--txt2)" }}>{d.label} {d.dnum}</span>
              <span style={{ display: "flex", justifyContent: "center", marginTop: 3 }}><CellIcon s={s} /></span>
            </button>
          ); })}
          {!isSelf && <Btn small kind="ghost" style={{ alignSelf: "center" }} onClick={() => setViewUserId(me)}>Back to my sheet</Btn>}
        </div>
      </div>

      <div style={{ display: "flex", justifyContent: "center" }}>
        <div style={{ width: "100%", maxWidth: 820, background: "var(--s1)", border: "1px solid var(--bdr)", borderRadius: 13, boxShadow: "0 12px 38px rgba(0,0,0,.12)", overflow: "hidden" }}>
          <div style={{ padding: "13px 24px", borderBottom: "1px solid var(--bdr)", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <FileText size={16} style={{ color: "var(--acc)" }} />
            <div style={{ fontWeight: 700, fontSize: 14 }}>Work update — {fmtDate(date)}</div>
            {!isSelf && <Pill color="var(--txt2)">{viewUser?.name}</Pill>}
            <div style={{ marginLeft: "auto", display: "flex", gap: 7, alignItems: "center", flexWrap: "wrap" }}>
              {entry ? <Pill color={scoreColor(entry.score)}>{entry.score === null || entry.score === undefined ? "unscored" : `${entry.score}/100 vs KPI`}</Pill> : editable ? <Pill color="var(--amber)"><Clock size={11} /> Not logged yet</Pill> : null}
              {entry && editable && <Pill color="var(--green)"><CheckCircle2 size={11} /> Logged · editable today</Pill>}
            </div>
          </div>
          <div style={{ padding: "34px 48px 26px" }}>
            {editable ? (
              <textarea ref={taRef} value={note} onChange={(e) => { setNote(e.target.value); e.target.style.height = "auto"; e.target.style.height = Math.max(360, e.target.scrollHeight) + "px"; }}
                placeholder={"Open-ended — write the day like a doc.\n\nWhat I learned about planning today…\nWhich decisions went wrong, and why…\nWhat could have been better…\n\nThis is the mistake & learning vault — the more honest it is, the more it teaches."}
                style={{ width: "100%", minHeight: 360, border: "none", outline: "none", background: "transparent", resize: "none", fontSize: 15, lineHeight: 1.85, color: "var(--txt)", fontFamily: "inherit" }} />
            ) : entry ? (
              <div style={{ whiteSpace: "pre-wrap", fontSize: 15, lineHeight: 1.85, minHeight: 220 }}>{noteOf(entry)}</div>
            ) : (
              <div style={{ minHeight: 220, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 9, color: "var(--txt2)" }}>
                {date > today ? <><Calendar size={22} style={{ opacity: 0.5 }} /><div style={{ fontSize: 13 }}>This day hasn't happened yet.</div></>
                  : date === today ? <><Clock size={22} style={{ color: "var(--amber)" }} /><div style={{ fontSize: 13 }}>Not logged yet today.</div></>
                  : <><X size={22} style={{ color: "var(--red)" }} /><div style={{ fontSize: 13, fontWeight: 600, color: "var(--red)" }}>No entry was written on this day — missed, on record.</div><div style={{ fontSize: 11.5 }}>The vault doesn't backfill; tomorrow's discipline is the fix.</div></>}
              </div>
            )}
            {entry && (entry.feedback || (entry.kpiHits || []).length > 0) && (
              <div style={{ marginTop: 22, borderTop: "1px dashed var(--bdr2)", paddingTop: 15 }}>
                <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                  <Bot size={15} style={{ color: "var(--acc)", flexShrink: 0, marginTop: 2 }} />
                  <div>
                    <div style={{ fontSize: 12.5, color: "var(--txt2)", lineHeight: 1.6 }}>{entry.feedback}</div>
                    {(entry.kpiHits || []).length > 0 && <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 7 }}>{entry.kpiHits.map((k, i) => <Pill key={i} color="var(--blue)">{k}</Pill>)}</div>}
                  </div>
                </div>
              </div>
            )}
          </div>
          {editable && (
            <div style={{ padding: "12px 24px", borderTop: "1px solid var(--bdr)", display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ fontSize: 11, color: "var(--txt3)", fontFamily: MONO }}>{note.trim() ? note.trim().split(/\s+/).length : 0} words</span>
              <span style={{ fontSize: 11.5, color: "var(--txt3)", flex: 1 }}>Plain date-wise entries; the score and feedback are stored with each day's response.</span>
              <Btn icon={wuBusy ? Loader2 : Sparkles} disabled={wuBusy || !note.trim()} onClick={submitWU}>{wuBusy ? "Scoring vs KPI…" : entry ? "Update — AI re-scores it against the KPI" : "Submit — AI tells you how it aligns with the KPI"}</Btn>
            </div>
          )}
        </div>
      </div>

      {team.length > 0 && (
        <div className="card" style={{ overflow: "hidden" }}>
          <div style={{ padding: "11px 16px", borderBottom: "1px solid var(--bdr)", fontSize: 11, fontWeight: 700, color: "var(--txt2)", textTransform: "uppercase", letterSpacing: ".06em" }}>Team sheet — click any day to read that person's page</div>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
              <thead><tr style={{ textAlign: "left", color: "var(--txt3)", fontSize: 11 }}>
                <th style={{ padding: "9px 16px", fontWeight: 600 }}>Person</th>
                {days.map((d) => <th key={d.date} style={{ padding: "9px 8px", fontFamily: MONO, fontWeight: 600, textAlign: "center" }}>{d.label} {d.dnum}</th>)}
              </tr></thead>
              <tbody>
                {team.map((u) => (
                  <tr key={u.id} style={{ borderTop: "1px solid var(--bdr)" }}>
                    <td style={{ padding: "8px 16px" }}><span style={{ display: "flex", alignItems: "center", gap: 8 }}><AvatarDot user={u} size={22} /> {u.name}</span></td>
                    {days.map((d) => { const s = cellState(u.id, d); return (
                      <td key={d.date} style={{ padding: "6px 8px", textAlign: "center" }}>
                        <button onClick={() => { setViewUserId(u.id); setDate(d.date); }} style={{ width: 28, height: 28, borderRadius: 7, border: "1px solid var(--bdr)", background: CELL_BG[s], cursor: "pointer", display: "inline-flex", alignItems: "center", justifyContent: "center" }}><CellIcon s={s} /></button>
                      </td>
                    ); })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function TrainingList({ isMgr }) {
  const { users, me, trainings, setTrainings } = useCtx();
  const my = users.find((u) => u.id === me);
  const isAdmin = ["superadmin", "dept_head"].includes(my?.role);
  const visTrainings = isMgr ? trainings : trainings.filter((t) => t.userId === me);
  if (visTrainings.length === 0) return <div style={{ fontSize: 12.5, color: "var(--txt2)" }}>No trainings assigned yet.</div>;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
      {visTrainings.map((tr) => {
        const u = users.find((x) => x.id === tr.userId);
        const canEdit = tr.userId === me || isAdmin;
        return (
          <div key={tr.id} style={{ display: "flex", alignItems: "center", gap: 10, border: "1px solid var(--bdr)", borderRadius: 10, padding: "9px 13px", flexWrap: "wrap" }}>
            <AvatarDot user={u} size={24} />
            <span style={{ fontWeight: 600, fontSize: 13, flex: 1, minWidth: 160 }}>{tr.title}</span>
            {tr.resource && <span style={{ fontSize: 11.5, color: "var(--acc)", fontFamily: MONO }}>{tr.resource}</span>}
            <Pill color="var(--txt2)"><Calendar size={10} /> {fmtDate(tr.due)}</Pill>
            {canEdit ? (
              <select className="inp" style={{ width: 130, padding: "5px 9px" }} value={tr.status} onChange={(e) => setTrainings((ts) => ts.map((x) => (x.id === tr.id ? { ...x, status: e.target.value } : x)))}>
                {["Assigned", "In Progress", "Done"].map((s) => <option key={s}>{s}</option>)}
              </select>
            ) : <Pill color={tr.status === "Done" ? "var(--green)" : tr.status === "In Progress" ? "var(--blue)" : "var(--txt2)"}>{tr.status}</Pill>}
          </div>
        );
      })}
    </div>
  );
}
function AssignTraining({ onClose }) {
  const { users, setTrainings, me, toast } = useCtx();
  const [f, setF] = useState({ userId: "", title: "", resource: "", due: "" });
  return (
    <Modal title="Assign training" onClose={onClose} width={460}
      footer={<Btn disabled={!f.userId || !f.title.trim()} icon={GraduationCap} onClick={() => { setTrainings((t) => [{ id: uid(), ...f, status: "Assigned", assignedBy: me, at: new Date().toISOString() }, ...t]); toast("Training assigned", "green"); onClose(); }}>Assign</Btn>}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <Field label="Person" req>
          <select className="inp" value={f.userId} onChange={(e) => setF({ ...f, userId: e.target.value })}>
            <option value="">— choose —</option>
            {users.filter((u) => u.role !== "superadmin").map((u) => <option key={u.id} value={u.id}>{u.name} — {u.title}</option>)}
          </select>
        </Field>
        <Field label="Training title" req><input className="inp" placeholder="e.g. DFM basics for 4-layer boards" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
        <Field label="Resource (link / doc name)"><input className="inp" value={f.resource} onChange={(e) => setF({ ...f, resource: e.target.value })} /></Field>
        <Field label="Due date"><input type="date" className="inp" value={f.due} onChange={(e) => setF({ ...f, due: e.target.value })} /></Field>
      </div>
    </Modal>
  );
}

/* ═══ MODULE 5 — SYSTEM MEMORY (admin) ═══════════════════════════════════ */
const MEM_TYPES = [["sitemap", "Drive sitemap"], ["template", "Template"], ["instruction", "Instruction set"], ["conversation", "Previous Claude conversation"], ["note", "Other note"]];
function MemoryModule() {
  const { memory, setMemory, syncLog, toast, resetAll } = useCtx();
  const [f, setF] = useState({ type: "sitemap", title: "", content: "", fileName: "" });
  const [confirmReset, setConfirmReset] = useState(false);
  const size = memCtx(memory).length;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div className="card" style={{ padding: 16 }}>
        <SectionTitle icon={Database} right={<Pill color="var(--purple)"><Sparkles size={11} /> Injected into every AI call</Pill>}>Add to system memory</SectionTitle>
        <div style={{ display: "grid", gridTemplateColumns: "170px 1fr", gap: 10, marginBottom: 10 }}>
          <Field label="Type"><select className="inp" value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>{MEM_TYPES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
          <Field label="Title"><input className="inp" placeholder="e.g. Drive sitemap — PCB ID folders" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
        </div>
        <Field label="Content"><textarea className="inp" rows={5} style={{ fontFamily: MONO, fontSize: 12 }} placeholder="Paste the template, instruction set, prior conversation, or folder sitemap…" value={f.content} onChange={(e) => setF({ ...f, content: e.target.value })} /></Field>
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, color: "var(--txt2)", cursor: "pointer", marginTop: 9 }}>
          <Upload size={14} />
          <span>{f.fileName ? <span style={{ fontFamily: MONO, fontSize: 12, color: "var(--txt)" }}>{f.fileName}</span> : "…or upload a doc — txt/md/json/csv are read straight into content; other types are stored as a named reference"}</span>
          <input type="file" style={{ display: "none" }} onChange={(e) => { const file = e.target.files[0]; if (!file) return; setF((prev) => ({ ...prev, fileName: file.name, title: prev.title || file.name.replace(/\.[^.]+$/, "") })); if (/\.(txt|md|json|csv)$/i.test(file.name)) { const r = new FileReader(); r.onload = () => setF((prev) => ({ ...prev, content: (prev.content ? prev.content + "\n" : "") + String(r.result).slice(0, 6000) })); r.readAsText(file); } }} />
        </label>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 11, flexWrap: "wrap" }}>
          <Btn icon={Plus} disabled={!f.title.trim() || (!f.content.trim() && !f.fileName)} onClick={() => { setMemory((m) => [{ id: uid(), ...f, content: f.content.trim() || `(content lives in the attached file ${f.fileName})`, createdAt: new Date().toISOString() }, ...m]); setF({ type: f.type, title: "", content: "", fileName: "" }); toast("Memory added — AI gets smarter", "green"); }}>Add memory</Btn>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flex: 1, minWidth: 200 }}>
            <span style={{ fontSize: 11, color: "var(--txt3)", whiteSpace: "nowrap" }}>AI context {size.toLocaleString()}/{MEM_BUDGET.toLocaleString()} ch</span>
            <Progress pct={Math.min(100, (size / MEM_BUDGET) * 100)} color={size > MEM_BUDGET * 0.9 ? "var(--amber)" : "var(--acc)"} />
          </div>
        </div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
        {memory.map((m) => (
          <div key={m.id} className="card" style={{ padding: "12px 15px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap" }}>
              <Pill color="var(--purple)">{MEM_TYPES.find(([k]) => k === m.type)?.[1] || m.type}</Pill>
              <span style={{ fontWeight: 700, fontSize: 13 }}>{m.title}</span>
              {m.fileName && <Pill color="var(--acc)"><FileText size={10} /> {m.fileName}</Pill>}
              <button style={{ marginLeft: "auto", background: "none", border: "none", color: "var(--txt3)", cursor: "pointer" }} onClick={() => setMemory((x) => x.filter((y) => y.id !== m.id))}><Trash2 size={14} /></button>
            </div>
            <pre style={{ marginTop: 7, fontSize: 11.5, fontFamily: MONO, whiteSpace: "pre-wrap", color: "var(--txt2)", lineHeight: 1.6 }}>{m.content}</pre>
          </div>
        ))}
      </div>
      <div className="card" style={{ padding: 16 }}>
        <SectionTitle icon={RefreshCw}>Sync log — Drive / Sheets integration seams</SectionTitle>
        {syncLog.length === 0 ? <div style={{ fontSize: 12.5, color: "var(--txt2)" }}>Nothing synced yet. Project creation, scrum pushes and task closures write here — in production these become the Drive/Sheets edge-function calls.</div> : (
          <div style={{ display: "flex", flexDirection: "column", gap: 5, maxHeight: 260, overflow: "auto" }}>
            {syncLog.map((s) => (
              <div key={s.id} style={{ display: "flex", gap: 9, fontSize: 12, alignItems: "baseline", flexWrap: "wrap" }}>
                <span style={{ fontFamily: MONO, fontSize: 10.5, color: "var(--txt3)", whiteSpace: "nowrap" }}>{new Date(s.at).toLocaleTimeString("en-IN", { hour12: false })}</span>
                <span style={{ fontFamily: MONO, fontSize: 11.5, color: "var(--acc)" }}>{s.target}</span>
                <span style={{ color: "var(--txt2)" }}>{s.detail}</span>
              </div>
            ))}
          </div>
        )}
        <div style={{ marginTop: 14, borderTop: "1px dashed var(--bdr2)", paddingTop: 12, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          {confirmReset ? (<>
            <span style={{ fontSize: 12.5, color: "var(--red)", fontWeight: 600 }}>This wipes every project, note, task and score. Sure?</span>
            <Btn small kind="danger" onClick={resetAll}>Yes — reset everything</Btn>
            <Btn small kind="ghost" onClick={() => setConfirmReset(false)}>Cancel</Btn>
          </>) : <Btn small kind="ghost" icon={Trash2} onClick={() => setConfirmReset(true)}>Reset all data</Btn>}
        </div>
      </div>
    </div>
  );
}

/* ═══ WORKSPACE ASSISTANT — the chat available on every page ═════════════ */
/* ── SHARED CHAT PIECES (module scope — components declared inside another
   component get a new identity every render and remount their subtree) ──── */

/* ═══ INTERNAL MoM ════════════════════════════════════════════════════════ */
function MomCard({ m, showProject }) {
  const [open, setOpen] = useState(false);
  const ai = m.ai || {};
  const solved = (ai.challenges || []).filter((c) => c.status === "solved").length;
  return (
    <div className="card" style={{ padding: 14, borderLeft: "3px solid var(--purple)" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 9, flexWrap: "wrap" }}>
        <span style={{ fontWeight: 700, fontSize: 13.5 }}>{ai.title || m.title || "Discussion"}</span>
        {showProject && <Pill color="var(--acc)" style={{ fontFamily: MONO }}>{m.projectId}</Pill>}
        <span style={{ fontSize: 11, color: "var(--txt3)", fontFamily: MONO }}>{fmtDate(m.date)} · {m.time}</span>
        <span style={{ fontSize: 11, color: "var(--txt3)" }}>by {m.byName}</span>
        {(ai.challenges || []).length > 0 && <Pill color={solved ? "var(--green)" : "var(--amber)"}>{solved}/{ai.challenges.length} beaten</Pill>}
        {(ai.ideas || []).length > 0 && <Pill color="var(--purple)"><Lightbulb size={10} /> {ai.ideas.length} idea{ai.ideas.length === 1 ? "" : "s"}</Pill>}
        {m.savedTo && <Pill color="var(--green)"><CheckCircle2 size={10} /> In Drive</Pill>}
        <button onClick={() => setOpen(!open)} style={{ marginLeft: "auto", background: "none", border: "none", color: "var(--acc)", cursor: "pointer", fontSize: 12, fontWeight: 600 }}>{open ? "Less" : "Open"}</button>
      </div>
      {ai.summary && <div style={{ fontSize: 12.5, color: "var(--txt2)", lineHeight: 1.6, marginTop: 6 }}>{ai.summary}</div>}
      {m.attendees && <div style={{ fontSize: 11, color: "var(--txt3)", marginTop: 4 }}>In the room: {m.attendees}</div>}

      {open && (
        <div className="fade" style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 13 }}>
          {(ai.challenges || []).length > 0 && (
            <div>
              <CardLabel>Challenges and how they went</CardLabel>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {ai.challenges.map((c, i) => {
                  const [label, colour] = MOM_STATUS[c.status] || MOM_STATUS.watch;
                  return (
                    <div key={i} style={{ border: `1px solid ${colour}`, borderRadius: 9, padding: "9px 11px", background: "var(--s2)" }}>
                      <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
                        <span style={{ fontWeight: 600, fontSize: 12.5, flex: 1, minWidth: 180 }}>{c.problem}</span>
                        <Pill color={colour}>{label}</Pill>
                      </div>
                      {c.solution && <div style={{ fontSize: 12, color: "var(--txt2)", marginTop: 4, lineHeight: 1.55 }}>{c.solution}</div>}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
          {(ai.ideas || []).length > 0 && (
            <div>
              <CardLabel>Who moved this forward</CardLabel>
              <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                {ai.ideas.map((x, i) => {
                  const im = impactOf(x.impact);
                  return (
                    <div key={i} style={{ display: "flex", gap: 9, alignItems: "flex-start" }}>
                      <Pill color={im.c} style={{ flexShrink: 0 }}>{x.by}</Pill>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 12.5, lineHeight: 1.55 }}>{x.idea}</div>
                        <div style={{ fontSize: 11, color: "var(--txt3)", marginTop: 2 }}>{im.label}{x.why ? ` · ${x.why}` : ""}</div>
                      </div>
                      <span title={`${x.value}/5 by impact`} style={{ flexShrink: 0, fontSize: 11, fontFamily: MONO, color: im.c, fontWeight: 700 }}>{"●".repeat(Math.max(1, Math.min(5, Number(x.value) || 1)))}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
          {(ai.decisions || []).length > 0 && (
            <div>
              <CardLabel>Decided</CardLabel>
              {ai.decisions.map((d, i) => (
                <div key={i} style={{ fontSize: 12.5, lineHeight: 1.6, display: "flex", gap: 7 }}>
                  <CheckCircle2 size={13} style={{ color: "var(--green)", flexShrink: 0, marginTop: 3 }} />
                  <span>{d.what}{d.owner ? <span style={{ color: "var(--txt3)" }}> — {d.owner}</span> : null}</span>
                </div>
              ))}
            </div>
          )}
          {(ai.lessons || []).length > 0 && (
            <div>
              <CardLabel right={<Pill color="var(--purple)"><Sparkles size={10} /> in system memory</Pill>}>What we learned</CardLabel>
              {ai.lessons.map((l, i) => (
                <div key={i} style={{ fontSize: 12.5, lineHeight: 1.6, display: "flex", gap: 7 }}>
                  <Lightbulb size={13} style={{ color: "var(--purple)", flexShrink: 0, marginTop: 3 }} />{l}
                </div>
              ))}
            </div>
          )}
          {m.raw && (
            <details>
              <summary style={{ cursor: "pointer", fontSize: 11.5, color: "var(--txt3)", fontWeight: 600 }}>the notes as they were written</summary>
              <div style={{ whiteSpace: "pre-wrap", fontSize: 12, color: "var(--txt2)", lineHeight: 1.6, marginTop: 7, padding: "9px 11px", background: "var(--s2)", borderRadius: 9 }}>{m.raw}</div>
            </details>
          )}
        </div>
      )}
    </div>
  );
}

/* Ranked contributors — named on every note, ranked here, and echoed on each
   person's Performance page. */
function IdeaBoard({ credit, compact }) {
  if (!credit.length) return null;
  const top = credit[0].score || 1;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
      {credit.slice(0, compact ? 5 : 20).map((c, i) => (
        <div key={c.name} style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ width: 18, flexShrink: 0, fontFamily: MONO, fontSize: 11, fontWeight: 800, color: i === 0 ? "var(--amber)" : "var(--txt3)" }}>{i + 1}</span>
          <span style={{ width: 120, flexShrink: 0, fontWeight: 600, fontSize: 12.5, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{c.name}</span>
          <span style={{ flex: 1, minWidth: 60, height: 9, background: "var(--s2)", borderRadius: 5, overflow: "hidden" }}>
            <span style={{ display: "block", width: `${Math.round((c.score / top) * 100)}%`, height: "100%", background: i === 0 ? "var(--amber)" : "var(--acc)" }} />
          </span>
          <span style={{ flexShrink: 0, fontSize: 11, color: "var(--txt2)", fontFamily: MONO, width: 96, textAlign: "right" }}>{c.count} idea{c.count === 1 ? "" : "s"} · {c.score}</span>
        </div>
      ))}
    </div>
  );
}

/* ═══ PLAN BOARD — one plan, four ways of looking at it ═══════════════════
   Gantt for the shape of the schedule, Flow for the sequence, Steps for the
   detail, Changes for who moved what and when. Clicking anything anywhere
   opens the same stage detail.                                              */
const PLAN_VIEWS = [["steps", "Steps"], ["flow", "Flow"], ["gantt", "Timeline"], ["log", "Changes"]];

/* One editable row in the Steps view. Module scope, or every keystroke would
   remount the inputs and lose focus. */
function StageEditRow({ s, i, count, onChange, onMove, onDelete, trackList }) {
  const set = (k) => (e) => onChange(i, { [k]: e.target.value });
  return (
    <div style={{ border: "1px solid var(--bdr)", borderRadius: 10, padding: 10, background: "var(--s1)", display: "flex", flexDirection: "column", gap: 7 }}>
      <div style={{ display: "flex", gap: 7, alignItems: "center" }}>
        <span style={{ fontFamily: MONO, fontSize: 10.5, color: "var(--txt3)", width: 18, flexShrink: 0 }}>{String(i + 1).padStart(2, "0")}</span>
        <input className="inp" style={{ flex: 1, minWidth: 120, fontWeight: 600 }} value={s.name} onChange={set("name")} placeholder="Stage name" />
        <button title="Move up" disabled={i === 0} onClick={() => onMove(i, -1)} style={{ background: "none", border: "1px solid var(--bdr)", borderRadius: 6, width: 26, height: 30, cursor: i === 0 ? "not-allowed" : "pointer", color: "var(--txt2)", opacity: i === 0 ? 0.4 : 1 }}>↑</button>
        <button title="Move down" disabled={i === count - 1} onClick={() => onMove(i, 1)} style={{ background: "none", border: "1px solid var(--bdr)", borderRadius: 6, width: 26, height: 30, cursor: i === count - 1 ? "not-allowed" : "pointer", color: "var(--txt2)", opacity: i === count - 1 ? 0.4 : 1 }}>↓</button>
        <button title="Remove this stage" onClick={() => onDelete(i)} style={{ background: "none", border: "1px solid var(--bdr)", borderRadius: 6, width: 28, height: 30, cursor: "pointer", color: "var(--red)", display: "flex", alignItems: "center", justifyContent: "center" }}><Trash2 size={13} /></button>
      </div>
      <div style={{ display: "flex", gap: 7, flexWrap: "wrap" }}>
        <select className="inp" style={{ width: 122, padding: "6px 8px" }} value={s.status} onChange={set("status")}>
          {PLAN_STATUS.map((x) => <option key={x.k} value={x.k}>{x.label}</option>)}
        </select>
        <input className="inp" list="eb-tracks" style={{ width: 128, padding: "6px 8px" }} value={s.track || ""} onChange={set("track")} placeholder="Workstream" />
        <datalist id="eb-tracks">{trackList.map((t) => <option key={t} value={t} />)}</datalist>
        <input className="inp" type="date" style={{ width: 142, padding: "6px 8px", fontFamily: MONO }} value={s.start || ""} onChange={set("start")} />
        <input className="inp" type="date" style={{ width: 142, padding: "6px 8px", fontFamily: MONO }} value={s.end || ""} onChange={set("end")} />
        <input className="inp" style={{ flex: 1, minWidth: 110, padding: "6px 8px" }} value={s.owner || ""} onChange={set("owner")} placeholder="Owner" />
      </div>
      <input className="inp" style={{ padding: "6px 8px", fontSize: 12 }} value={s.note || ""} onChange={set("note")} placeholder="One line on where this stands (optional)" />
    </div>
  );
}

/* One to-do as it reads underneath its stage. */
function StageTaskRow({ t, users }) {
  const u = users.find((x) => x.id === t.assigneeId);
  const c = t.status === "done" ? "var(--green)" : t.status === "blocked" ? "var(--red)" : t.status === "in-progress" ? "var(--blue)" : "var(--txt3)";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, padding: "2px 0" }}>
      <span style={{ width: 7, height: 7, borderRadius: "50%", background: c, flexShrink: 0 }} />
      <span style={{ flex: 1, minWidth: 0, textDecoration: t.status === "done" ? "line-through" : "none", color: t.status === "done" ? "var(--txt3)" : "var(--txt)" }}>{t.title}</span>
      {t.date && <span style={{ fontSize: 10.5, color: "var(--txt3)", fontFamily: MONO, flexShrink: 0 }}>{fmtDate(t.date)}</span>}
      <span style={{ color: "var(--txt3)", fontSize: 11, flexShrink: 0 }}>{u?.name || "unassigned"}</span>
    </div>
  );
}

function StageDetail({ stage, tasks, users, onClose }) {
  if (!stage) return null;
  const mine = tasks.filter((t) => t.stageId === stage.id || (stage.tasks || []).includes(t.id));
  return (
    <div className="fade" style={{ marginTop: 12, border: `1px solid ${planColor(stage.status)}`, borderRadius: 12, padding: 14, background: "var(--s1)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap", marginBottom: 9 }}>
        <span style={{ width: 9, height: 9, borderRadius: "50%", background: planColor(stage.status), flexShrink: 0 }} />
        <span style={{ fontWeight: 800, fontSize: 14 }}>{stage.name}</span>
        <Pill color={planColor(stage.status)}>{planLabel(stage.status)}</Pill>
        <Pill color="var(--txt2)"><Calendar size={10} /> {fmtDate(stage.start)} → {fmtDate(stage.end)}</Pill>
        {stage.owner && <Pill color="var(--purple)">{stage.owner}</Pill>}
        <button onClick={onClose} style={{ marginLeft: "auto", background: "none", border: "none", color: "var(--txt2)", cursor: "pointer", display: "flex", padding: 2 }}><X size={16} /></button>
      </div>
      {stage.note && <div style={{ fontSize: 12.5, color: "var(--txt2)", lineHeight: 1.6, marginBottom: 9 }}>{stage.note}</div>}
      {(stage.evidence || []).length > 0 && (
        <div style={{ marginBottom: 9 }}>
          <div style={{ fontSize: 10.5, fontWeight: 700, color: "var(--txt3)", textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 5 }}>Proof in Drive</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {stage.evidence.map((f, i) => <Pill key={i} color="var(--acc)"><FileText size={10} /> {f}</Pill>)}
          </div>
        </div>
      )}
      <div style={{ fontSize: 10.5, fontWeight: 700, color: "var(--txt3)", textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 5 }}>Tasks on this stage</div>
      {mine.length === 0 ? <div style={{ fontSize: 12, color: "var(--txt3)" }}>None raised yet.</div> : (
        <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
          {mine.map((t) => (
            <div key={t.id} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5 }}>
              <span style={{ width: 6, height: 6, borderRadius: "50%", background: t.status === "done" ? "var(--green)" : t.status === "blocked" ? "var(--red)" : "var(--blue)", flexShrink: 0 }} />
              <span style={{ flex: 1, minWidth: 0, textDecoration: t.status === "done" ? "line-through" : "none", color: t.status === "done" ? "var(--txt3)" : "var(--txt)" }}>{t.title}</span>
              <span style={{ color: "var(--txt3)", fontSize: 11 }}>{users.find((u) => u.id === t.assigneeId)?.name || "unassigned"}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function PlanBoard({ p, upd, projTasks, users, busy, onBuild, onSheet, onFile, filing, myName }) {
  const [view, setView] = useState("steps");
  const [openId, setOpenId] = useState("");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState([]);
  const sheetRef = useRef(null);
  const plan = p.plan;
  const stages = plan?.stages || [];
  const open = stages.find((s) => s.id === openId) || null;
  const knownTracks = [...new Set([...stages.map((s) => s.track).filter(Boolean), "Hardware", "Firmware", "Enclosure", "Testing", "Supply chain", "PM"])];

  /* Editing works on a copy; nothing moves until Save, and Save writes one
     log entry describing exactly what changed. */
  const startEdit = () => { setDraft(stages.map((s) => ({ ...s }))); setEditing(true); setOpenId(""); };
  const saveEdits = () => {
    const kept = draft.filter((s) => String(s.name || "").trim()).map((s, i) => ({ ...s, name: s.name.trim(), id: s.id || `stage-${i}` }));
    const before = stages;
    const bits = [];
    if (kept.length !== before.length) bits.push(`${before.length} → ${kept.length} stages`);
    if (kept.map((s) => s.id).join() !== before.map((s) => s.id).join()) bits.push("order or membership changed");
    for (const s of kept) {
      const b = before.find((x) => x.id === s.id);
      if (!b) { bits.push(`added ${s.name}`); continue; }
      const d = [];
      if (b.name !== s.name) d.push(`renamed from ${b.name}`);
      if (b.status !== s.status) d.push(`${b.status} → ${s.status}`);
      if (b.start !== s.start || b.end !== s.end) d.push(`dates ${b.start || "?"}–${b.end || "?"} → ${s.start || "?"}–${s.end || "?"}`);
      if ((b.track || "") !== (s.track || "")) d.push(`workstream → ${s.track || "none"}`);
      if ((b.owner || "") !== (s.owner || "")) d.push(`owner → ${s.owner || "nobody"}`);
      if (d.length) bits.push(`${s.name}: ${d.join(", ")}`);
    }
    const entry = { id: uid(), at: new Date().toISOString(), byName: myName || "someone", why: "Edited the steps by hand", what: bits.join(" · ").slice(0, 600) || "no change" };
    upd((cur) => ({ plan: { ...(cur.plan || {}), stages: kept, updatedAt: entry.at, log: [entry, ...(cur.plan?.log || [])].slice(0, 100) } }));
    setEditing(false);
  };

  /* One shared date window for the bars. */
  const dates = stages.flatMap((s) => [s.start, s.end]).filter(Boolean).map((d) => new Date(d).getTime()).filter((n) => !Number.isNaN(n));
  const t0 = dates.length ? Math.min(...dates) : Date.now();
  const t1 = dates.length ? Math.max(...dates) : Date.now() + 86400000;
  const span = Math.max(1, t1 - t0);
  const pctOf = (d) => Math.max(0, Math.min(100, ((new Date(d).getTime() - t0) / span) * 100));
  const todayMs = new Date(todayStr()).getTime();
  const todayInRange = todayMs >= t0 && todayMs <= t1;
  const todayPct = pctOf(todayStr());
  const doneN = stages.filter((s) => s.status === "done").length;
  const activeStage = stages.find((s) => s.status === "active") || stages.find((s) => s.status === "blocked");
  const groups = trackGroups(stages);
  const showTracks = hasTracks(stages);

  return (
    <Section>
      <div style={{ display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap", marginBottom: 12 }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: "var(--txt)", textTransform: "uppercase", letterSpacing: ".06em" }}>Project plan</span>
        {stages.length > 0 && <Pill color="var(--green)">{doneN}/{stages.length} stages done</Pill>}
        {activeStage && <Pill color={planColor(activeStage.status)}>Now: {activeStage.name}</Pill>}
        <div style={{ marginLeft: "auto", display: "flex", gap: 7, alignItems: "center", flexWrap: "wrap" }}>
          {stages.length > 0 && !editing && (
            <div style={{ display: "flex", gap: 2, background: "var(--s2)", borderRadius: 8, padding: 2 }}>
              {PLAN_VIEWS.map(([k, label]) => (
                <button key={k} onClick={() => setView(k)} style={{ padding: "5px 11px", borderRadius: 6, border: "none", cursor: "pointer", fontSize: 11.5, fontWeight: 700, background: view === k ? "var(--s1)" : "transparent", color: view === k ? "var(--acc)" : "var(--txt2)" }}>{label}</button>
              ))}
            </div>
          )}
          {editing ? (<>
            <Btn small kind="green" icon={CheckCircle2} onClick={saveEdits}>Save plan</Btn>
            <Btn small kind="ghost" onClick={() => setEditing(false)}>Cancel</Btn>
          </>) : (<>
            <input ref={sheetRef} type="file" accept=".xlsx,.xls,.csv,.tsv,.txt,.md" style={{ display: "none" }}
              onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) onSheet(f); }} />
            <Btn small kind="ghost" icon={busy ? Loader2 : Upload} disabled={busy} title="Build the plan from your own checklist" onClick={() => sheetRef.current?.click()}>Upload checklist</Btn>
            {stages.length > 0 && <Btn small kind="ghost" icon={filing ? Loader2 : ListChecks} disabled={filing} title="Put every open to-do under the stage it belongs to" onClick={() => onFile()}>{filing ? "Filing…" : "File the to-dos"}</Btn>}
            {stages.length > 0 && <Btn small kind="ghost" icon={Pencil} onClick={startEdit}>Edit steps</Btn>}
            <Btn small kind={stages.length ? "ghost" : "primary"} icon={busy ? Loader2 : Sparkles} disabled={busy} onClick={onBuild}>
              {busy ? "Working…" : stages.length ? "Refresh from Drive" : "Build from Drive"}
            </Btn>
          </>)}
        </div>
      </div>

      {stages.length === 0 && !editing ? (
        <Empty icon={Gauge} title={busy ? "Reading the project's files…" : "No plan yet"} sub="Build it from Drive and the AI reads this project's folders — the checklist, the reports, the board folders — and lays out the real stages, what runs alongside what, and where you are now. Or upload your own checklist and it will follow that instead. After that, tell the chat about a customer's feedback or a vendor delay and it moves the plan for you." />
      ) : editing ? (
        <div className="fade" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ fontSize: 12, color: "var(--txt2)", lineHeight: 1.6 }}>
            Put things that run at the same time on the same dates with different workstreams — Hardware and Firmware side by side, for example. The order here is the order everywhere else.
          </div>
          {draft.map((s, i) => (
            <StageEditRow key={s.id} s={s} i={i} count={draft.length} trackList={knownTracks}
              onChange={(idx, patch) => setDraft((d) => d.map((x, j) => (j === idx ? { ...x, ...patch } : x)))}
              onMove={(idx, dir) => setDraft((d) => { const n = [...d]; const [x] = n.splice(idx, 1); n.splice(Math.max(0, Math.min(n.length, idx + dir)), 0, x); return n; })}
              onDelete={(idx) => setDraft((d) => d.filter((_, j) => j !== idx))} />
          ))}
          <Btn small kind="ghost" icon={Plus} onClick={() => setDraft((d) => [...d, { id: `stage-${uid()}`, name: "", status: "pending", track: d[d.length - 1]?.track || "", start: todayStr(), end: todayStr(), owner: "", note: "", evidence: [] }])}>Add a stage</Btn>
        </div>
      ) : (<>
        {plan?.summary && <div style={{ fontSize: 12.5, color: "var(--txt2)", lineHeight: 1.65, marginBottom: 12 }}>{plan.summary}</div>}

        {view === "gantt" && (
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10.5, color: "var(--txt3)", fontWeight: 700, marginBottom: 6 }}>
              <span>{fmtDate(new Date(t0).toISOString().slice(0, 10))}</span><span>{fmtDate(new Date(t1).toISOString().slice(0, 10))}</span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
              {/* One lane per workstream, so things running side by side look
                  like they run side by side rather than one after another. */}
              {groups.map(([track, list]) => (
                <div key={track}>
                  {showTracks && <div style={{ fontSize: 10, fontWeight: 800, color: "var(--txt3)", textTransform: "uppercase", letterSpacing: ".07em", margin: "7px 0 3px" }}>{track}</div>}
                  {list.map((s) => {
                    const a = pctOf(s.start), b = pctOf(s.end);
                    return (
                      <button key={s.id} onClick={() => setOpenId(openId === s.id ? "" : s.id)}
                        style={{ display: "flex", alignItems: "center", gap: 10, background: openId === s.id ? "var(--s2)" : "transparent", border: "none", borderRadius: 7, padding: "4px 6px", cursor: "pointer", textAlign: "left", width: "100%" }}>
                        <span style={{ width: 132, flexShrink: 0, fontSize: 11.5, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", color: s.status === "pending" ? "var(--txt2)" : "var(--txt)" }}>{s.name}</span>
                        {/* today's line belongs INSIDE the bar track — measured
                            against the whole row it pointed at the wrong date */}
                        <span style={{ position: "relative", flex: 1, height: 16, background: "var(--s2)", borderRadius: 5, minWidth: 90, overflow: "hidden" }}>
                          <span style={{ position: "absolute", left: `${a}%`, width: `${Math.max(2.5, b - a)}%`, top: 0, bottom: 0, borderRadius: 5, background: planColor(s.status), opacity: s.status === "pending" ? 0.4 : 1 }} />
                          {todayInRange && <span title="today" style={{ position: "absolute", left: `${todayPct}%`, top: 0, bottom: 0, width: 2, background: "var(--red)", opacity: 0.7, pointerEvents: "none" }} />}
                        </span>
                        <span style={{ width: 74, flexShrink: 0, fontSize: 10.5, color: "var(--txt3)", fontFamily: MONO, textAlign: "right" }}>{String(s.end || "").slice(5)}</span>
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
        )}

        {view === "flow" && (
          /* One row per workstream — parallel work reads as parallel rows. */
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {groups.map(([track, list]) => (
              <div key={track}>
                {showTracks && <div style={{ fontSize: 10, fontWeight: 800, color: "var(--txt3)", textTransform: "uppercase", letterSpacing: ".07em", marginBottom: 5 }}>{track}</div>}
                <div style={{ display: "flex", gap: 0, overflowX: "auto", paddingBottom: 4 }}>
                  {list.map((s, i) => (
                    <div key={s.id} style={{ display: "flex", alignItems: "center", flexShrink: 0 }}>
                      <button onClick={() => setOpenId(openId === s.id ? "" : s.id)}
                        style={{ width: 128, padding: "10px 11px", borderRadius: 10, cursor: "pointer", textAlign: "left", background: openId === s.id ? "var(--soft)" : "var(--s1)", border: `1.5px solid ${openId === s.id ? "var(--acc)" : planColor(s.status)}` }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 5 }}>
                          <span style={{ width: 8, height: 8, borderRadius: "50%", background: planColor(s.status), flexShrink: 0 }} />
                          <span style={{ fontSize: 10, fontWeight: 700, color: "var(--txt3)", fontFamily: MONO }}>{String(stages.indexOf(s) + 1).padStart(2, "0")}</span>
                        </div>
                        <div style={{ fontSize: 12, fontWeight: 700, lineHeight: 1.35, marginBottom: 4 }}>{s.name}</div>
                        <div style={{ fontSize: 10, color: "var(--txt3)" }}>{String(s.end || "").slice(5)}</div>
                      </button>
                      {i < list.length - 1 && <span style={{ width: 16, height: 2, background: "var(--bdr2)", flexShrink: 0 }} />}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        {view === "steps" && (
          <div style={{ display: "flex", flexDirection: "column", gap: showTracks ? 10 : 0 }}>
            {groups.map(([track, list]) => (
              <div key={track}>
                {showTracks && <div style={{ fontSize: 10, fontWeight: 800, color: "var(--txt3)", textTransform: "uppercase", letterSpacing: ".07em", marginBottom: 4 }}>{track}</div>}
                {list.map((s, i) => {
                  // Anything overlapping this stage's dates on a different
                  // workstream is being worked on at the same time.
                  const alongside = stages.filter((o) => o.id !== s.id && (o.track || "") !== (s.track || "")
                    && s.start && s.end && o.start && o.end && o.start <= s.end && o.end >= s.start).map((o) => o.name);
                  const mine = projTasks.filter((t) => t.stageId === s.id);
                  const openN = mine.filter((t) => t.status !== "done").length;
                  const isOpen = openId === s.id;
                  return (
                    <div key={s.id}>
                    <button onClick={() => setOpenId(isOpen ? "" : s.id)}
                      style={{ display: "flex", gap: 11, background: isOpen ? "var(--s2)" : "transparent", border: "none", borderRadius: 8, padding: "8px 7px", cursor: "pointer", textAlign: "left", width: "100%" }}>
                      <span style={{ display: "flex", flexDirection: "column", alignItems: "center", flexShrink: 0 }}>
                        <span style={{ width: 15, height: 15, borderRadius: "50%", border: `2px solid ${planColor(s.status)}`, background: s.status === "done" ? planColor(s.status) : "transparent", display: "flex", alignItems: "center", justifyContent: "center" }}>
                          {s.status === "done" && <CheckCircle2 size={9} style={{ color: "#fff" }} />}
                        </span>
                        {i < list.length - 1 && <span style={{ flex: 1, width: 2, minHeight: 16, background: "var(--bdr2)", marginTop: 3 }} />}
                      </span>
                      <span style={{ flex: 1, minWidth: 0, paddingBottom: 4 }}>
                        <span style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                          <ChevronDown size={13} style={{ color: "var(--txt3)", flexShrink: 0, transform: isOpen ? "none" : "rotate(-90deg)", transition: "transform .15s" }} />
                          <span style={{ fontWeight: 700, fontSize: 13 }}>{s.name}</span>
                          <Pill color={planColor(s.status)}>{planLabel(s.status)}</Pill>
                          {mine.length > 0 && <Pill color="var(--purple)"><ListChecks size={10} /> {openN ? `${openN} open` : "all done"} · {mine.length}</Pill>}
                          {s.owner && <span style={{ fontSize: 11, color: "var(--txt3)" }}>{s.owner}</span>}
                          <span style={{ fontSize: 11, color: "var(--txt3)", fontFamily: MONO }}>{fmtDate(s.start)} → {fmtDate(s.end)}</span>
                        </span>
                        {s.note && <span style={{ display: "block", fontSize: 12, color: "var(--txt2)", marginTop: 3, lineHeight: 1.55 }}>{s.note}</span>}
                        {alongside.length > 0 && (
                          <span style={{ display: "block", fontSize: 11, color: "var(--txt3)", marginTop: 3 }}>
                            runs alongside {alongside.slice(0, 3).join(", ")}{alongside.length > 3 ? ` and ${alongside.length - 3} more` : ""}
                          </span>
                        )}
                      </span>
                    </button>
                    {/* the to-dos of this stage, nested under it */}
                    {isOpen && (
                      <div className="fade" style={{ margin: "0 0 8px 26px", paddingLeft: 12, borderLeft: "2px solid var(--bdr2)", display: "flex", flexDirection: "column", gap: 5 }}>
                        {mine.length === 0
                          ? <div style={{ fontSize: 12, color: "var(--txt3)", padding: "3px 0" }}>No to-dos filed under this stage yet.</div>
                          : mine.map((t) => <StageTaskRow key={t.id} t={t} users={users} />)}
                        {(s.evidence || []).length > 0 && (
                          <div style={{ marginTop: 5 }}>
                            <div style={{ fontSize: 10, fontWeight: 700, color: "var(--txt3)", textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 4 }}>Proof in Drive</div>
                            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                              {s.evidence.map((f, k) => <Pill key={k} color="var(--acc)"><FileText size={10} /> {f}</Pill>)}
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        )}

        {view === "log" && (
          (plan?.log || []).length === 0
            ? <Empty icon={Clock} title="No changes yet" sub="Every time the plan moves — a customer's feedback, a vendor delay, a stage finishing — it is recorded here with who did it and when." />
            : (
              <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
                {plan.log.map((l) => (
                  <div key={l.id} style={{ borderLeft: "2px solid var(--acc)", paddingLeft: 11 }}>
                    <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
                      <span style={{ fontWeight: 700, fontSize: 12.5 }}>{l.byName}</span>
                      <span style={{ fontSize: 11, color: "var(--txt3)", fontFamily: MONO }}>{fmtDate(String(l.at).slice(0, 10))} · {String(l.at).slice(11, 16)}</span>
                    </div>
                    {l.why && <div style={{ fontSize: 12.5, color: "var(--txt)", marginTop: 2, lineHeight: 1.55 }}>{l.why}</div>}
                    <div style={{ fontSize: 11.5, color: "var(--txt2)", marginTop: 2, lineHeight: 1.5 }}>{l.what}</div>
                  </div>
                ))}
              </div>
            )
        )}

        {view !== "log" && view !== "steps" && <StageDetail stage={open} tasks={projTasks} users={users} onClose={() => setOpenId("")} />}
      </>)}
    </Section>
  );
}

/* An action line is only a success if it actually succeeded. Painting every
   one of them green with a tick made a run of failures read as a run of wins. */
const sysColor = (m) => {
  if (m.confirm) return "var(--amber)";
  if (m.ok === false) return "var(--red)";
  if (m.ok === true) return "var(--green)";
  // older messages carry no flag — read the sentence
  return /^(i couldn't|couldn't|i could not|i can't|i cannot|nothing|no |failed|there was nothing|i'm not sure|i don't)/i.test(String(m.text || "").trim())
    ? "var(--red)" : "var(--green)";
};

/* A document the AI wrote, shown in the chat like a real artefact: name,
   preview, open/close, download, and where it went in Drive. */
function DocCard({ doc }) {
  const [open, setOpen] = useState(false);
  const content = String(doc.content || "");
  const lines = content.split("\n");
  return (
    <div className="fade" style={{ border: "1px solid var(--bdr2)", borderRadius: 12, background: "var(--s1)", overflow: "hidden", maxWidth: 560, width: "100%" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "9px 12px", background: "var(--soft)", borderBottom: open ? "1px solid var(--bdr)" : "none", flexWrap: "wrap" }}>
        <FileText size={15} style={{ color: "var(--acc)", flexShrink: 0 }} />
        <div style={{ flex: 1, minWidth: 140 }}>
          <div style={{ fontWeight: 700, fontSize: 12.5, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 300 }}>{doc.title || doc.fileName}</div>
          <div style={{ fontSize: 10.5, color: "var(--txt2)", fontFamily: MONO }}>{doc.fileName} · {lines.length} lines{doc.savedTo ? ` · in ${doc.savedTo}'s Drive folder` : ""}</div>
        </div>
        {doc.savedTo && <Pill color="var(--green)"><CheckCircle2 size={10} /> In Drive</Pill>}
        <Btn small kind="ghost" onClick={() => setOpen(!open)}>{open ? "Close" : "Open"}</Btn>
        <Btn small kind="ghost" icon={Download} title="Download to this computer" onClick={() => downloadDoc(doc)}> </Btn>
      </div>
      {!open && <div style={{ padding: "8px 13px", fontSize: 11.5, color: "var(--txt2)", fontFamily: MONO, whiteSpace: "pre-wrap", maxHeight: 54, overflow: "hidden" }}>{lines.slice(0, 3).join("\n")}</div>}
      {open && <pre style={{ margin: 0, padding: "12px 14px", fontSize: 12, fontFamily: MONO, whiteSpace: "pre-wrap", maxHeight: 340, overflowY: "auto", color: "var(--txt)" }}>{content}</pre>}
    </div>
  );
}

/* The chips row above a chat input showing what is about to be sent.
   Images get a thumbnail so a pasted screenshot is recognisable. */
function AttachStrip({ atts, setAtts }) {
  if (!atts.length) return null;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 6, padding: "8px 0 0" }}>
      {atts.map((a) => (
        <span key={a.id} style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "4px 7px 4px 6px", borderRadius: 8, border: `1px solid ${a.tooBig ? "var(--amber)" : "var(--bdr2)"}`, background: "var(--s2)", fontSize: 11.5 }}>
          {a.preview
            ? <img src={a.preview} alt="" style={{ width: 26, height: 26, borderRadius: 5, objectFit: "cover", display: "block" }} />
            : <FileText size={11} style={{ color: a.tooBig ? "var(--amber)" : "var(--acc)", marginLeft: 4 }} />}
          <span style={{ fontWeight: 600, maxWidth: 160, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{a.name}</span>
          <span style={{ color: "var(--txt3)", fontSize: 10.5 }}>{a.tooBig ? "too big" : a.text != null ? "readable" : kb(a.size)}</span>
          <button onClick={() => setAtts((x) => x.filter((y) => y.id !== a.id))} style={{ background: "none", border: "none", color: "var(--txt3)", cursor: "pointer", display: "flex", padding: 1 }}><X size={12} /></button>
        </span>
      ))}
    </div>
  );
}

/* The paperclip that goes next to a chat input. */
function ClipButton({ fileRef, onPick }) {
  return (<>
    <input ref={fileRef} type="file" multiple style={{ display: "none" }} onChange={(e) => { onPick(e.target.files); e.target.value = ""; }} />
    <button title="Attach a file — or drop one on the chat" onClick={() => fileRef.current?.click()}
      style={{ width: 38, height: 36, flexShrink: 0, borderRadius: 8, border: "1px solid var(--bdr)", background: "var(--s2)", color: "var(--txt2)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <Paperclip size={15} />
    </button>
  </>);
}

/* File badges on an already-sent chat message. */
const FileBadges = ({ files }) => !files?.length ? null : (
  <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 7 }}>
    {files.map((f, i) => (
      <span key={i} style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "3px 9px", borderRadius: 99, background: "rgba(255,255,255,.2)", fontSize: 11 }}>
        <FileText size={10} /> {f.name} · {kb(f.size)}
      </span>
    ))}
  </div>
);

function WorkspaceChat() {
  const { projects, tasks, users, notes, me, memory, toast } = useCtx();
  const [open, setOpen] = useState(false);
  const [msgs, setMsgs] = useState([]);
  const [val, setVal] = useState("");
  const [busy, setBusy] = useState(false);
  const [atts, setAtts] = useState([]);
  const fileRef = useRef(null);
  const lastAtts = useRef([]);
  const bodyRef = useRef(null);
  const my = users.find((u) => u.id === me);
  useEffect(() => { if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight; }, [msgs.length, busy, open, atts.length]);

  const send = async (preset) => {
    const q = (preset || val).trim();
    if ((!q && !atts.length) || busy) return;
    const hist = msgs;
    const sent = atts;
    if (sent.length) lastAtts.current = sent;
    const pool = sent.length ? sent : lastAtts.current;
    const mineText = q || `Sent ${sent.map((a) => a.name).join(", ")}`;
    setMsgs((m) => [...m, { id: uid(), who: "me", text: mineText, files: sent.length ? sent.map((a) => ({ name: a.name, size: a.size })) : undefined }]);
    setVal(""); setAtts([]); setBusy(true);
    const ctx = {
      meName: my?.name || "there", meTitle: my?.title || "",
      projects: projects.map((p) => {
        const ts = tasks.filter((t) => t.projectId === p.projectId);
        return { projectId: p.projectId, name: p.name, status: p.status, deadline: p.deadline, knownStatus: p.knownStatus,
          pmName: users.find((u) => u.id === (p.team || []).find((t) => t.slot.startsWith("PM"))?.userId)?.name,
          done: ts.filter((t) => t.status === "done").length, total: ts.length };
      }),
      openTasks: tasks.filter((t) => t.status !== "done").map((t) => ({
        title: t.title, who: users.find((u) => u.id === t.assigneeId)?.name || "unassigned",
        projectId: t.projectId, status: t.status, when: [t.date, t.endTime].filter(Boolean).join(" "),
      })),
      team: users.filter((u) => u.id !== "u-admin").map((u) => ({ name: u.name, title: u.title, load: tasks.filter((t) => t.assigneeId === u.id && t.status !== "done").length })),
      notes: notes.map((n) => ({ date: n.date, raw: n.raw })),
    };
    let reply;
    try { reply = await claude(workspacePrompt(ctx, hist, q, memory, pool, sent.length > 0), { json: false, images: imageBlocks(pool), web: true }); }
    catch {
      const openN = ctx.openTasks.length;
      reply = `I can't reach the AI right now, so here's the short version: you have ${ctx.projects.length} project${ctx.projects.length === 1 ? "" : "s"} and ${openN} open task${openN === 1 ? "" : "s"}.${ctx.projects.length ? ` Closest deadline: ${[...ctx.projects].sort((a, b) => String(a.deadline).localeCompare(String(b.deadline)))[0]?.name}.` : ""}`;
    }
    // <<<SAVETO project | file name>>> — file one attached document into that
    // project's Drive folder, exactly as it was sent. One line per file, so two
    // documents never end up duplicated across two projects.
    const saveTos = [...String(reply).matchAll(/<<<SAVETO\s+([^>\n]+?)\s*>>>/g)];
    let clean = String(reply).replace(/<<<SAVETO[^>]*>>>/g, "").trim();
    if (saveTos.length) {
      const usable = pool.filter((f) => !f.tooBig && !f.failed);
      const results = [];
      for (const [, spec] of saveTos.slice(0, 5)) {
        const [rawPid, rawName] = String(spec).split("|");
        const proj = findProject(projects, (rawPid || "").trim());
        if (!proj) { results.push(`I couldn't find a project called ${(rawPid || "").trim()}.`); continue; }
        if (!usable.length) { results.push("Attach the file again and I'll keep it."); continue; }
        const want = normId(rawName);
        const f = (want && (usable.find((x) => normId(x.name) === want) || usable.find((x) => normId(x.name).includes(want) || want.includes(normId(x.name)))))
          || (usable.length === 1 ? usable[0] : null);
        if (!f) { results.push(`You have ${usable.length} files here — tell me which one goes into ${proj.projectId} and I'll file it.`); continue; }
        const r = await saveAttachmentToDrive(f, proj.projectId, driveScope(my?.role));
        results.push(saveResult(r, f.name, proj.projectId));
      }
      clean = [clean, results.join("\n")].filter(Boolean).join("\n\n");
      if (results.some((r) => r.startsWith("Saved"))) toast("Saved to Drive", "green");
    }
    setMsgs((m) => [...m, { id: uid(), who: "ai", text: clean || reply }]);
    setBusy(false);
  };
  // keep one clean list (the optimistic user message is already in state)
  const shown = msgs.filter((m, i, a) => !(m.who === "me" && a[i + 1]?.who === "me" && a[i + 1]?.text === m.text));

  const SUGGESTIONS = ["What needs my attention today?", "Who is free this week?", "Which projects are at risk?"];
  if (!open) return (
    <button onClick={() => setOpen(true)} title="Ask the assistant" style={{ position: "fixed", right: 20, bottom: 20, zIndex: 1500, display: "flex", alignItems: "center", gap: 9, padding: "12px 18px", borderRadius: 99, border: "none", background: "var(--acc)", color: "#fff", fontWeight: 700, fontSize: 13.5, cursor: "pointer", boxShadow: "0 8px 26px rgba(37,99,235,.4)" }}>
      <Bot size={17} /> Ask anything
    </button>
  );
  return (
    <div className="fade" style={{ position: "fixed", right: 20, bottom: 20, zIndex: 1500, width: "min(420px, calc(100vw - 40px))", height: "min(560px, calc(100vh - 100px))", display: "flex", flexDirection: "column", background: "var(--s1)", border: "1px solid var(--bdr)", borderRadius: 16, boxShadow: "0 24px 70px rgba(0,0,0,.28)", overflow: "hidden" }}>
      <div style={{ padding: "13px 16px", borderBottom: "1px solid var(--bdr)", display: "flex", alignItems: "center", gap: 9, background: "var(--soft)" }}>
        <Bot size={17} style={{ color: "var(--acc)" }} />
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 700, fontSize: 13.5 }}>Assistant</div>
          <div style={{ fontSize: 11, color: "var(--txt2)" }}>Knows your projects, tasks and team</div>
        </div>
        <button onClick={() => setOpen(false)} style={{ background: "none", border: "none", color: "var(--txt2)", cursor: "pointer", padding: 4 }}><X size={17} /></button>
      </div>
      <div ref={bodyRef} style={{ flex: 1, overflowY: "auto", padding: 14, display: "flex", flexDirection: "column", gap: 9 }}>
        {shown.length === 0 && !busy && (
          <div style={{ fontSize: 12.5, color: "var(--txt2)", lineHeight: 1.7 }}>
            Hi {my?.name?.split(" ")[0] || "there"} — ask me anything about your work.
            <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 10, alignItems: "flex-start" }}>
              {SUGGESTIONS.map((s) => <button key={s} onClick={() => send(s)} style={chipS(false)}>{s}</button>)}
            </div>
          </div>
        )}
        {shown.map((m) => (
          <div key={m.id} style={{ display: "flex", justifyContent: m.who === "me" ? "flex-end" : "flex-start" }}>
            <div style={{ maxWidth: "88%", padding: "9px 13px", borderRadius: m.who === "me" ? "13px 13px 4px 13px" : "13px 13px 13px 4px", background: m.who === "me" ? "var(--acc)" : "var(--s2)", color: m.who === "me" ? "#fff" : "var(--txt)", fontSize: 12.5, lineHeight: 1.6, whiteSpace: "pre-wrap" }}>
              {m.text}
              <FileBadges files={m.files} />
            </div>
          </div>
        ))}
        {busy && <div style={{ padding: "7px 13px", borderRadius: 13, background: "var(--s2)", alignSelf: "flex-start" }}><TypingDots /></div>}
      </div>
      {atts.length > 0 && <div style={{ padding: "0 12px" }}><AttachStrip atts={atts} setAtts={setAtts} /></div>}
      <div style={{ padding: 12, borderTop: "1px solid var(--bdr)", display: "flex", gap: 8 }}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => { e.preventDefault(); pickAttachments(e.dataTransfer?.files, setAtts, toast); }}>
        <ClipButton fileRef={fileRef} onPick={(fs) => pickAttachments(fs, setAtts, toast)} />
        <input className="inp" style={{ flex: 1 }} placeholder={atts.length ? "What should I do with it?" : "Ask anything, or paste a screenshot…"} value={val} onChange={(e) => setVal(e.target.value)} onPaste={(e) => { const fs = filesFromPaste(e); if (fs.length) { e.preventDefault(); pickAttachments(fs, setAtts, toast); } }} onKeyDown={(e) => e.key === "Enter" && send()} />
        <Btn icon={busy ? Loader2 : Send} disabled={busy || (!val.trim() && !atts.length)} onClick={() => send()} style={{ width: 42, padding: 0 }} title="Send"> </Btn>
      </div>
    </div>
  );
}

/* ═══ ASSISTANT — THE COMMAND CENTRE ON THE MAIN MENU ════════════════════
   A full-page chat that can read the whole workspace AND change it. The model
   replies in plain English and appends <<<DO>>>{json}<<<END>>> blocks; every
   block is executed here against real state, and what happened is reported
   back in the conversation. Destructive actions wait for a confirm click.   */
const ASSIST_SUGGESTIONS = [
  "Today Ravi finishes the rev-B gerbers and Neha freezes the BoM",
  "Put Ravi on ESP32-123 as a junior hardware engineer",
  "What is inside the ESP32-123 folder?",
  "Remember: every gerber check needs the DRC report saved next to it",
];
/* Forgiving people lookup — first name, surname, near-enough spelling. */
const findPerson = (users, name) => {
  const n = normId(name);
  if (!n) return null;
  return users.find((u) => normId(u.name) === n)
    || users.find((u) => normId(u.name).startsWith(n))
    || users.find((u) => normId(u.name).includes(n))
    || users.find((u) => n.includes(normId(u.name.split(" ")[0])))
    || null;
};
const findProject = (projects, pid) => {
  const n = normId(pid);
  if (!n) return null;
  return projects.find((p) => normId(p.projectId) === n)
    || projects.find((p) => normId(p.projectId).includes(n) || n.includes(normId(p.projectId)))
    || projects.find((p) => normId(p.name).includes(n))
    || null;
};
const PAGE_NAMES = { projects: "Create a Project", scrum: "Daily Scrum", tasks: "My Projects & Tasks", resources: "Resources", perf: "Performance & Training", memory: "System Memory", assistant: "Assistant" };

function AssistantModule() {
  const { users, me, projects, setProjects, tasks, setTasks, notes, setNotes, memory, setMemory, setTrainings, toast, sheetSync, setView, addUser, assistantLog, setAssistantLog } = useCtx();
  const [day, setDay] = useState(todayStr());
  const [val, setVal] = useState("");
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState("");   // what it is doing right now, in words
  const [atts, setAtts] = useState([]);
  const bodyRef = useRef(null);
  const fileRef = useRef(null);
  const lastAtts = useRef([]);          // so "save that to EB-09" still works next turn
  const my = users.find((u) => u.id === me);

  /* The chat is one shared, day-wise history: every message is stamped with
     the date, the time and the name of whoever sent it, and it persists. */
  const dayMsgs = assistantLog.filter((m) => m.date === day);
  const days = [...new Set([todayStr(), ...assistantLog.map((m) => m.date)])].sort().reverse();
  useEffect(() => { if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight; }, [dayMsgs.length, busy, atts.length, day]);

  const pickFiles = (fileList) => pickAttachments(fileList, setAtts, toast);

  const say = (who, text, extra) => setAssistantLog((m) => [...m, { id: uid(), who, text, date: todayStr(), time: nowHM(), by: me, byName: my?.name || "", ...(extra || {}) }]);

  /* Everything the model can see. */
  const buildCtx = () => ({
    meName: my?.name || "there", meTitle: my?.title || "", isAdmin: my?.role === "superadmin",
    projects: projects.map((p) => {
      const ts = tasks.filter((t) => t.projectId === p.projectId);
      return { projectId: p.projectId, name: p.name, status: p.status, deadline: p.deadline, knownStatus: p.knownStatus,
        pmName: users.find((u) => u.id === (p.team || []).find((t) => t.slot.startsWith("PM"))?.userId)?.name,
        teamNames: (p.team || []).map((t) => `${users.find((u) => u.id === t.userId)?.name || "?"} (${t.slot})`).join(", "),
        done: ts.filter((t) => t.status === "done").length, total: ts.length };
    }),
    openTasks: tasks.filter((t) => t.status !== "done").map((t) => ({
      title: t.title, who: users.find((u) => u.id === t.assigneeId)?.name || "unassigned",
      projectId: t.projectId, status: t.status, when: [t.date, t.endTime].filter(Boolean).join(" "),
    })),
    team: users.map((u) => ({ name: u.name, title: u.title, dept: u.dept, load: tasks.filter((t) => t.assigneeId === u.id && t.status !== "done").length })),
    notes,
  });

  /* Execute one DO block. Returns { line, driveWanted?, confirm? }. */
  const runAction = async (a, live) => {
    const A = String(a.action || "").toLowerCase();
    const proj = (pid) => findProject(live.projects, pid);
    switch (A) {
      case "create_project": {
        const pid = (String(a.projectId || "").trim() || `EB-${todayStr().slice(2, 4)}-${String(live.projects.length + 1).padStart(3, "0")}`).replace(/[^A-Za-z0-9-]/g, "-");
        if (proj(pid)) return { line: `${pid} already exists — I left it as it is.` };
        const team = (a.team || []).map((t) => {
          const u = findPerson(users, t.name);
          return u ? { slot: t.slot || "Jr. Hardware Engineer", userId: u.id } : null;
        }).filter(Boolean);
        const p = {
          id: uid(), projectId: pid, idMode: "manual", name: a.name || pid, clientName: a.clientName || "",
          clientId: a.clientId || "", deadline: a.deadline || "", status: STATUSES.some((s) => s.k === a.status) ? a.status : "Planning",
          linkedIds: a.linkedIds || [], knownStatus: a.knownStatus || "", team, source: "assistant",
          createdAt: new Date().toISOString(), createdBy: me,
        };
        live.projects = [p, ...live.projects];
        setProjects((ps) => [p, ...ps]);
        sheetSync(`${pmPath(pid)}`, "Project created from the assistant");
        return { line: `Created ${pid} — ${p.name}${team.length ? ` with ${team.length} person(s) on it` : ""}.` };
      }
      case "update_project": {
        const p = proj(a.projectId);
        if (!p) return { line: `I couldn't find a project called ${a.projectId}.` };
        const patch = {};
        for (const k of ["name", "deadline", "knownStatus", "clientName", "linkedIds"]) if (a[k] != null && a[k] !== "") patch[k] = a[k];
        if (STATUSES.some((s) => s.k === a.status)) patch.status = a.status;
        live.projects = live.projects.map((x) => (x.id === p.id ? { ...x, ...patch } : x));
        setProjects((ps) => ps.map((x) => (x.id === p.id ? { ...x, ...patch } : x)));
        return { line: `Updated ${p.projectId}${patch.status ? ` — now ${patch.status}` : ""}.` };
      }
      case "delete_project": {
        const p = proj(a.projectId);
        if (!p) return { ok: false, line: `There is no project called ${a.projectId}.` };
        return { confirm: { ids: [p.id], label: `Delete ${p.projectId} — ${p.name}? Its tasks stay, but the project goes.` } };
      }
      /* "delete all of them except 1752" is one instruction, so it gets one
         action, one list and one button — not sixteen rounds of asking. */
      case "delete_projects": {
        const keep = new Set((a.except || a.keep || []).map((x) => normId(x)).filter(Boolean));
        const asked = a.projectIds || a.projects || [];
        const named = asked.map((x) => proj(x)).filter(Boolean);
        // "everything" only when they actually said everything. A list of names
        // that resolves to nothing must delete nothing — falling through to the
        // sweep here would wipe the workspace over a typo.
        const sweep = a.all === true || asked.length === 0;
        if (!sweep && !named.length) {
          return { ok: false, line: `I couldn't find ${asked.map((x) => `"${x}"`).join(" or ")} — nothing matched that, so nothing was touched.` };
        }
        let victims = sweep
          ? live.projects.filter((x) => ![...keep].some((k) => normId(x.projectId).includes(k) || k.includes(normId(x.projectId))))
          : named;
        // never let a vague "all" quietly include something they said to keep
        if (keep.size) victims = victims.filter((x) => ![...keep].some((k) => normId(x.projectId).includes(k)));
        victims = [...new Map(victims.map((x) => [x.id, x])).values()];
        if (!victims.length) return { ok: false, line: "Nothing matched that — no projects were touched." };
        const names = victims.map((x) => x.projectId);
        return {
          confirm: {
            ids: victims.map((x) => x.id),
            label: `Delete ${victims.length} project${victims.length === 1 ? "" : "s"}${keep.size ? `, keeping ${[...keep].length === 1 ? names.length ? (a.except || a.keep)[0] : "" : (a.except || a.keep).join(", ")}` : ""}? Their tasks stay, the projects go.\n${names.join(", ")}`,
          },
        };
      }
      case "assign_resource": {
        const p = proj(a.projectId), u = findPerson(users, a.name);
        if (!p) return { line: `I couldn't find a project called ${a.projectId}.` };
        if (!u) return { line: `I couldn't find anyone called ${a.name} in the team.` };
        if ((p.team || []).some((t) => t.userId === u.id)) return { line: `${u.name} is already on ${p.projectId}.` };
        const slot = TEAM_SLOTS.includes(a.slot) ? a.slot : (u.title || "Jr. Hardware Engineer");
        const team = [...(p.team || []), { slot, userId: u.id }];
        live.projects = live.projects.map((x) => (x.id === p.id ? { ...x, team } : x));
        setProjects((ps) => ps.map((x) => (x.id === p.id ? { ...x, team } : x)));
        sheetSync(`${pmPath(p.projectId)}`, `${u.name} added as ${slot}`);
        return { line: `${u.name} is now on ${p.projectId} as ${slot}.` };
      }
      case "unassign_resource": {
        const p = proj(a.projectId), u = findPerson(users, a.name);
        if (!p || !u) return { line: `I couldn't match ${a.name || "that person"} to ${a.projectId || "that project"}.` };
        const team = (p.team || []).filter((t) => t.userId !== u.id);
        live.projects = live.projects.map((x) => (x.id === p.id ? { ...x, team } : x));
        setProjects((ps) => ps.map((x) => (x.id === p.id ? { ...x, team } : x)));
        return { line: `Took ${u.name} off ${p.projectId}.` };
      }
      case "add_resource": {
        if (!a.name) return { line: "I need a name to add someone." };
        if (findPerson(users, a.name)) return { line: `${a.name} is already in the team.` };
        const rr = rrInfo(a.resourceRole);
        const u = { id: uuid(), name: a.name, email: a.email || "", title: a.title || rr?.label || "Engineer",
          role: ["superadmin", "dept_head", "pm", "engineer"].includes(a.role) ? a.role : "engineer",
          dept: a.dept || rr?.dept || "", resourceRole: a.resourceRole || "", skills: a.skills || rr?.skills || [],
          maxProjects: a.maxProjects || rr?.cap || 3, projectTags: [], color: "#2563eb" };
        await addUser(u);
        return { line: `Added ${u.name} to the team as ${u.title}.` };
      }
      case "add_task": {
        if (!a.title) return { line: "I need a task title." };
        const u = findPerson(users, a.assignee);
        const p = proj(a.projectId);
        const t = { id: uid(), projectId: p?.projectId || "", linked: !!p, title: a.title, assigneeId: u?.id || "",
          date: a.date || todayStr(), startTime: a.startTime || nowHM(),
          endTime: a.endTime || new Date(Date.now() + 60 * 60000).toTimeString().slice(0, 5),
          steps: [], conditions: [], status: "pending", origin: "assistant", createdBy: me, createdAt: new Date().toISOString(), work: {},
          stageId: guessStageId(p?.plan?.stages || [], { title: a.title, date: a.date || todayStr(), assigneeName: u?.name || "" }) };
        live.tasks = [t, ...live.tasks];
        setTasks((ts) => [t, ...ts]);
        if (p) sheetSync(`${pmPath(p.projectId)}Checklist.xlsx`, `Task "${t.title}" raised from the assistant`);
        return { line: `Task raised: ${t.title}${u ? ` for ${u.name}` : ""}${p ? ` on ${p.projectId}` : ""}, due ${t.endTime} today.` };
      }
      case "update_task": {
        const needle = normId(a.match || a.title);
        const t = live.tasks.find((x) => normId(x.title).includes(needle)) || null;
        if (!t) return { line: `I couldn't find a task like "${a.match || a.title}".` };
        const patch = {};
        if (["pending", "in-progress", "blocked", "done"].includes(a.status)) patch.status = a.status;
        if (a.status === "done") patch.completedAt = new Date().toISOString();
        const u = findPerson(users, a.assignee);
        if (u) patch.assigneeId = u.id;
        if (a.endTime) patch.endTime = a.endTime;
        live.tasks = live.tasks.map((x) => (x.id === t.id ? { ...x, ...patch } : x));
        setTasks((ts) => ts.map((x) => (x.id === t.id ? { ...x, ...patch } : x)));
        return { line: `Updated "${t.title}"${patch.status ? ` — ${patch.status}` : ""}${u ? `, now with ${u.name}` : ""}.` };
      }
      case "add_scrum_note": {
        const date = a.date || todayStr();
        const dayN = notes.filter((n) => n.date === date).length;
        const raw = String(a.text || "").trim();
        if (!raw) return { line: "There was nothing to put in the scrum." };
        // Carry a visible one-liner so the note reads without expanding it.
        const n = { id: uid(), date, noteNo: dayN + 1, time: nowHM(), raw, organized: { summary: raw.slice(0, 220), engine: "assistant" }, origin: "assistant", by: me, createdAt: new Date().toISOString() };
        setNotes((ns) => [n, ...ns]);
        return { line: `Written into the ${date === todayStr() ? "today's" : date} scrum as Note ${n.noteNo}. Open Daily Scrum and press Organise with AI to turn it into tasks.` };
      }
      case "list_memory": {
        if (!memory.length) return { line: "System Memory is empty — there are no standing rules yet." };
        return { line: memory.map((m) => `[${m.type || "instruction"}] ${m.title}: ${String(m.content).slice(0, 400)}`).join("\n") };
      }
      case "update_memory": {
        const want = normId(a.match);
        const hit = memory.find((m) => normId(m.title) === want)
          || memory.find((m) => normId(m.title).includes(want) || want.includes(normId(m.title)))
          || memory.find((m) => normId(m.content).includes(want));
        if (!hit) return { ok: false, line: `There is no standing rule matching "${a.match}".` };
        const next = { ...hit, title: a.title || hit.title, content: String(a.content), updatedAt: new Date().toISOString() };
        setMemory((mm) => mm.map((m) => (m.id === hit.id ? next : m)));
        return { line: `Rewrote the rule "${next.title}". Every AI answer from now on follows the new wording.` };
      }
      case "delete_memory": {
        const want = normId(a.match);
        const hit = memory.find((m) => normId(m.title) === want)
          || memory.find((m) => normId(m.title).includes(want) || want.includes(normId(m.title)))
          || memory.find((m) => normId(m.content).includes(want));
        if (!hit) return { ok: false, line: `There is no standing rule matching "${a.match}".` };
        setMemory((mm) => mm.filter((m) => m.id !== hit.id));
        return { line: `Dropped the rule "${hit.title}".` };
      }
      case "add_memory": {
        if (!a.content) return { line: "There was nothing to remember." };
        setMemory((m) => [{ id: uid(), type: a.type || "instruction", title: a.title || String(a.content).slice(0, 40), content: String(a.content), createdAt: new Date().toISOString() }, ...m]);
        return { line: `Saved to system memory: ${a.title || String(a.content).slice(0, 40)}. Every AI answer from now on knows it.` };
      }
      case "assign_training": {
        const u = findPerson(users, a.name);
        if (!u || !a.title) return { line: `I couldn't assign that training${a.name ? ` to ${a.name}` : ""}.` };
        setTrainings((t) => [{ id: uid(), userId: u.id, title: a.title, resource: a.resource || "", due: a.due || "", status: "Assigned", assignedBy: me, at: new Date().toISOString() }, ...t]);
        return { line: `Training "${a.title}" assigned to ${u.name}${a.due ? `, due ${fmtDate(a.due)}` : ""}.` };
      }
      case "read_drive": {
        const p = proj(a.projectId);
        const pid = p?.projectId || a.projectId || "";
        const term = a.search || "";
        if (!pid && !term.trim()) return { line: "" };
        const { digest, error } = await driveReadDigest(pid, p?.linkedIds, { scope: driveScope(my?.role), search: term });
        const asked = pid || `"${term}"`;
        return {
          ok: !!digest,
          line: digest ? "" : (error
            || `I searched ${DRIVE_CHAIN} for ${asked} and nothing there matched. Try the exact folder or file name, or tell me which project it sits under.`),
          drive: digest,
        };
      }
      case "save_attachment": {
        const want = normId(a.name);
        const f = (live.attachments || []).find((x) => normId(x.name) === want)
          || (live.attachments || []).find((x) => normId(x.name).includes(want) || want.includes(normId(x.name)))
          || (live.attachments || [])[0];
        if (!f) return { line: "There is no file attached to save." };
        if (f.tooBig || f.failed) return { line: `${f.name} is too big for me to handle here.` };
        const p = proj(a.projectId);
        if (!p) return { line: `I couldn't find a project called ${a.projectId} to put ${f.name} in.` };
        const r = await saveAttachmentToDrive(f, p.projectId, driveScope(my?.role));
        if (r === true) sheetSync(`${pmPath(p.projectId)}`, `${f.name} uploaded from the assistant`);
        return { line: saveResult(r, f.name, p.projectId) };
      }
      case "list_folder": {
        const { listing, error } = await driveListFolder(a.folderPath || "");
        if (error) return { ok: false, line: error };
        return { line: "", drive: listing || "That folder is empty." };
      }
      case "write_drive_file": {
        const p = proj(a.projectId);
        const fileName = String(a.fileName || "note.md").replace(/[\\/:*?"<>|]/g, "-");
        const content = String(a.content || "");
        const where = a.folderPath ? String(a.folderPath) : (p?.projectId || a.projectId);
        const r = await driveWriteFile(a.folderPath ? "" : (p?.projectId || a.projectId), fileName, content, { scope: driveScope(my?.role), folderPath: a.folderPath || "" });
        if (r === true && p) sheetSync(`${pmPath(p.projectId)}`, `${fileName} written from the assistant`);
        return {
          ok: r === true,
          line: saveResult(r, fileName, where),
          doc: { title: a.title || fileName, fileName, content: content.slice(0, 12000), savedTo: r === true ? where : "" },
        };
      }
      case "create_doc": {
        const fileName = String(a.fileName || (a.title ? `${String(a.title).replace(/[^\w\- ]/g, "").trim().replace(/\s+/g, "-")}.md` : "document.md")).replace(/[\\/:*?"<>|]/g, "-");
        const content = String(a.content || "");
        if (!content.trim()) return { line: "" };
        let savedTo = "", why = "";
        const p = a.projectId ? proj(a.projectId) : null;
        if (p || a.folderPath) {
          const target = a.folderPath ? String(a.folderPath) : p.projectId;
          const r = await driveWriteFile(a.folderPath ? "" : p.projectId, fileName, content, { scope: driveScope(my?.role), folderPath: a.folderPath || "" });
          if (r === true) { savedTo = target; if (p) sheetSync(`${pmPath(p.projectId)}`, `${fileName} created from the assistant`); }
          else why = String(r);
        }
        return {
          line: savedTo ? `Created ${fileName} — it's below, and filed in ${savedTo}'s Drive folder.`
            : why ? `Created ${fileName} — it's below. It didn't reach Drive though: ${why}`
            : `Created ${fileName} — it's below. Open it or download it.`,
          doc: { title: a.title || fileName, fileName, content: content.slice(0, 12000), savedTo },
        };
      }
      case "open_page": {
        if (!PAGE_NAMES[a.page]) return { line: "" };
        setView(a.page);
        return { line: `Opened ${PAGE_NAMES[a.page]} for you.` };
      }
      default:
        return { line: "" };
    }
  };

  const doDelete = (ids) => {
    const list = Array.isArray(ids) ? ids : [ids];
    const gone = projects.filter((x) => list.includes(x.id));
    setProjects((ps) => ps.filter((x) => !list.includes(x.id)));
    const names = gone.map((x) => x.projectId);
    toast(names.length === 1 ? `${names[0]} deleted` : `${names.length} projects deleted`, "amber");
    say("sys", names.length === 1
      ? `Deleted ${names[0] || "the project"}.`
      : `Deleted ${names.length} projects: ${names.join(", ")}.`, { ok: true });
  };

  /* One turn, however many steps it takes. The model calls tools, sees what
     came back and decides what to do next, until the job is done. */
  const send = async (preset) => {
    const q = (preset || val).trim();
    if ((!q && !atts.length) || busy) return;
    setDay(todayStr());
    const sent = atts;
    if (sent.length) lastAtts.current = sent;
    const pool = sent.length ? sent : lastAtts.current;
    say("me", q || `Sent ${sent.map((a) => a.name).join(", ")}`, sent.length ? { files: sent.map((a) => ({ name: a.name, size: a.size })) } : null);
    setVal(""); setAtts([]); setBusy(true);

    const live = { projects: [...projects], tasks: [...tasks], attachments: pool };
    const confirms = []; const docs = [];
    // What actually changed, kept so the person sees a record and not only the
    // model's summary of itself. Reads are not changes and are left out.
    const changed = []; let anyFailed = false;
    const READS = new Set(["read_drive", "list_projects"]);

    /* One tool call. Everything the model should see next comes back as text;
       side effects on the workspace happen here. */
    const exec = async (name, input) => {
      if (name === "list_projects") {
        return JSON.stringify(live.projects.map((p) => ({
          projectId: p.projectId, name: p.name, status: p.status, deadline: p.deadline,
          client: p.clientName, linkedIds: p.linkedIds || [],
          team: (p.team || []).map((t) => `${users.find((u) => u.id === t.userId)?.name || "?"} (${t.slot})`),
        })));
      }
      const r = await runAction({ action: name, ...input }, live);
      if (r.doc) docs.push(r.doc);
      if (r.confirm) {
        confirms.push(r.confirm);
        return "Queued — the user has been asked to confirm this. Do not call it again; carry on with the rest and mention it is waiting on them.";
      }
      if (r.line && (!READS.has(name) || r.ok === false)) {
        changed.push(r.line);
        if (r.ok === false) anyFailed = true;
      }
      if (r.drive) return `Drive contents:\n${r.drive}`;
      return r.line || (r.ok === false ? "That did not work." : "Done.");
    };

    /* What the model sees of this conversation: the real turns, plus whatever
       is attached — pictures as pictures, documents as documents. */
    // Pictures as pictures, PDFs as documents — and every single one also
    // NAMED in the text, contents inlined where we could read them. A file the
    // model cannot name is a file it cannot file away.
    const asBlock = new Set((pool || []).filter((a) => a.b64 && !a.tooBig && (IMG_OK.includes(a.mime) || a.mime === "application/pdf")).map((a) => a.id));
    const restText = !(pool || []).length ? "" : `\n\nFILES IN YOUR HANDS RIGHT NOW — you can read these and you can file any of them into a project with save_attachment, using the exact name below. Never say you cannot take or read an upload:\n${pool.map((a) => a.tooBig
      ? `- ${a.name} (${kb(a.size)}) — too big to open here, but it can still be filed.`
      : asBlock.has(a.id)
        ? `- ${a.name} (${kb(a.size)}, ${a.mime}) — attached to this message above; look at it directly.`
        : a.text != null
          ? `- ${a.name} (${kb(a.size)}), contents:\n"""${a.text}"""`
          : `- ${a.name} (${kb(a.size)}, ${a.mime}) — a document they handed you. Not stored anywhere yet.`).join("\n")}`;
    const content = [
      ...imageBlocks(pool),
      ...docBlocks(pool),
      { type: "text", text: (q || "(they attached the files above without saying anything — work out what they want, or ask in one line)") + restText },
    ];
    const history = assistantLog
      .filter((m) => m.date === todayStr() && (m.who === "me" || m.who === "ai") && String(m.text || "").trim())
      .slice(-20)
      .map((m) => ({ role: m.who === "me" ? "user" : "assistant", content: String(m.text) }));
    // an assistant turn cannot open the conversation
    while (history.length && history[0].role !== "user") history.shift();

    try {
      let spoke = false;
      await runAgent({
        messages: [...history, { role: "user", content }],
        system: agentSystem(buildCtx(), memory),
        exec,
        onStep: (name, input) => setStep(stepLabel(name, input)),
        onText: (text) => { say("ai", text); spoke = true; },
      });
      if (!spoke) say("ai", "Done.");
      for (const d of docs) say("doc", "", { doc: d });
      if (changed.length) say("sys", changed.join("\n"), { ok: !anyFailed });
      if (confirms.length) {
        const ids = [...new Set(confirms.flatMap((c) => c.ids || []))];
        say("sys", confirms.length === 1
          ? confirms[0].label
          : `Delete these ${ids.length} projects? Their tasks stay, the projects go.\n${projects.filter((x) => ids.includes(x.id)).map((x) => x.projectId).join(", ")}`,
          { confirm: { ids } });
      }
    } catch (e) {
      say("sys", `I couldn't finish that — ${String(e?.message || e).slice(0, 200)}`, { ok: false });
    }
    setStep(""); setBusy(false);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div className="card" style={{ display: "flex", flexDirection: "column", height: "calc(100vh - 190px)", minHeight: 460, overflow: "hidden" }}>
        <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--bdr)", background: "var(--soft)", display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap" }}>
          <Bot size={17} style={{ color: "var(--acc)" }} />
          <div style={{ fontWeight: 700, fontSize: 13.5, flex: 1, minWidth: 180 }}>Tell me what you need and I'll do it</div>
          <Pill color="var(--purple)"><Sparkles size={11} /> Runs the whole tool</Pill>
          {DRIVE_READ_URL ? <Pill color="var(--green)"><FolderPlus size={11} /> Drive connected</Pill> : null}
          <select className="inp" title="Chats are kept day by day" style={{ width: 150, padding: "6px 9px", fontSize: 12 }} value={day} onChange={(e) => setDay(e.target.value)}>
            {days.map((d) => {
              const n = assistantLog.filter((m) => m.date === d && m.who !== "sys").length;
              return <option key={d} value={d}>{d === todayStr() ? "Today" : fmtDate(d)}{n ? ` · ${n}` : ""}</option>;
            })}
          </select>
          {dayMsgs.length > 0 && <Btn small kind="ghost" icon={RefreshCw} title="Clear this day's chat" onClick={() => { setAssistantLog((m) => m.filter((x) => x.date !== day)); setDay(todayStr()); }}>Clear</Btn>}
        </div>
        <div ref={bodyRef} style={{ flex: 1, overflowY: "auto", padding: 18, display: "flex", flexDirection: "column", gap: 11 }}>
          {dayMsgs.length === 0 && !busy && (
            <div style={{ fontSize: 13, color: "var(--txt2)", lineHeight: 1.75, maxWidth: 620 }}>
              {day === todayStr() ? <>
                Hi {my?.name?.split(" ")[0] || "there"} — write it the way you'd say it out loud. I'll create the project, put people on it, raise the tasks, write today's scrum, remember what you tell me, write real documents you can open and download, and read or update the project files in Drive. Attach a file with the clip below (or just drop it in) and I'll read it or file it away for you. Everything we say here is kept day by day, with everyone's name on it.
                <div style={{ display: "flex", flexDirection: "column", gap: 7, marginTop: 14, alignItems: "flex-start" }}>
                  {ASSIST_SUGGESTIONS.map((s) => <button key={s} onClick={() => send(s)} style={chipS(false)}>{s}</button>)}
                </div>
              </> : <>Nothing was said on {fmtDate(day)}.</>}
            </div>
          )}
          {dayMsgs.length > 0 && (
            <div style={{ alignSelf: "center", fontSize: 11, fontWeight: 700, color: "var(--txt3)", textTransform: "uppercase", letterSpacing: ".05em", padding: "2px 12px", borderRadius: 99, background: "var(--s2)" }}>
              {day === todayStr() ? "Today" : fmtDate(day)}
            </div>
          )}
          {dayMsgs.map((m) => m.who === "sys" ? (
            <div key={m.id} className="fade" style={{ alignSelf: "flex-start", maxWidth: "88%", border: `1px solid ${sysColor(m)}`, background: `color-mix(in srgb, ${sysColor(m)} 8%, transparent)`, borderRadius: 11, padding: "10px 14px", fontSize: 12.5, lineHeight: 1.65, whiteSpace: "pre-wrap", display: "flex", gap: 9 }}>
              {m.confirm || sysColor(m) !== "var(--green)"
                ? <AlertTriangle size={15} style={{ color: sysColor(m), flexShrink: 0, marginTop: 2 }} />
                : <CheckCircle2 size={15} style={{ color: "var(--green)", flexShrink: 0, marginTop: 2 }} />}
              <div>
                {m.text}
                {m.confirm && (
                  <div style={{ display: "flex", gap: 8, marginTop: 9 }}>
                    <Btn small kind="danger" icon={Trash2} onClick={() => {
                      const ids = m.confirm.ids || (m.confirm.id ? [m.confirm.id] : []);
                      doDelete(ids);
                      setAssistantLog((x) => x.map((y) => (y.id === m.id ? { ...y, confirm: null, text: ids.length > 1 ? `Deleted all ${ids.length}.` : "Deleted." } : y)));
                    }}>{(m.confirm.ids || []).length > 1 ? `Yes, delete all ${m.confirm.ids.length}` : "Yes, delete"}</Btn>
                    <Btn small kind="ghost" onClick={() => setAssistantLog((x) => x.map((y) => (y.id === m.id ? { ...y, confirm: null, text: "Left it alone." } : y)))}>Keep it</Btn>
                  </div>
                )}
              </div>
            </div>
          ) : m.who === "doc" ? (
            <div key={m.id} style={{ display: "flex", justifyContent: "flex-start", maxWidth: "88%" }}>
              <DocCard doc={m.doc || {}} />
            </div>
          ) : (
            <div key={m.id} style={{ display: "flex", flexDirection: "column", alignItems: m.who === "me" ? "flex-end" : "flex-start", gap: 3 }}>
              <div style={{ fontSize: 10.5, fontWeight: 700, color: "var(--txt3)", padding: "0 4px" }}>
                {m.who === "me" ? (m.byName || "You") : "Assistant"}{m.time ? ` · ${m.time}` : ""}
              </div>
              <div style={{ maxWidth: "82%", padding: "10px 14px", borderRadius: m.who === "me" ? "14px 14px 4px 14px" : "14px 14px 14px 4px", background: m.who === "me" ? "var(--acc)" : "var(--s2)", color: m.who === "me" ? "#fff" : "var(--txt)", fontSize: 13, lineHeight: 1.65, whiteSpace: "pre-wrap" }}>
                {m.text}
                <FileBadges files={m.files} />
              </div>
            </div>
          ))}
          {busy && (
            <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "8px 14px", borderRadius: 13, background: "var(--s2)", alignSelf: "flex-start" }}>
              <TypingDots />
              {/* say what it is actually doing — a multi-step job is a long
                  time to watch three dots */}
              {step && <span style={{ fontSize: 12, color: "var(--txt2)", fontWeight: 600 }}>{step}</span>}
            </div>
          )}
        </div>
        {atts.length > 0 && <div style={{ padding: "0 13px" }}><AttachStrip atts={atts} setAtts={setAtts} /></div>}
        <div
          onDragOver={(e) => { e.preventDefault(); }}
          onDrop={(e) => { e.preventDefault(); pickFiles(e.dataTransfer?.files); }}
          style={{ padding: 13, borderTop: "1px solid var(--bdr)", display: "flex", gap: 9, alignItems: "center" }}>
          <ClipButton fileRef={fileRef} onPick={pickFiles} />
          <input className="inp" style={{ flex: 1 }} placeholder={atts.length ? "What should I do with it?" : "Type, or paste a screenshot — e.g. create project EB-26-014 for Acme, due 30 Sep"} value={val} onChange={(e) => setVal(e.target.value)} onPaste={(e) => { const fs = filesFromPaste(e); if (fs.length) { e.preventDefault(); pickFiles(fs); } }} onKeyDown={(e) => e.key === "Enter" && send()} />
          <Btn icon={busy ? Loader2 : Send} disabled={busy || (!val.trim() && !atts.length)} onClick={() => send()}>{busy ? "Working…" : "Send"}</Btn>
        </div>
      </div>
    </div>
  );
}

/* ═══ INTERNAL MoM — every session, and who has been contributing ════════ */
function MomModule() {
  const { projects, setView } = useCtx();
  const [q, setQ] = useState("");
  const [proj, setProj] = useState("");
  const sessions = allMoms(projects);
  const credit = momCredit(projects);
  const needle = normId(q);
  const shown = sessions.filter((m) =>
    (!proj || m.projectId === proj)
    && (!needle || normId(JSON.stringify([m.title, m.raw, m.attendees, m.ai])).includes(needle)));

  const challenges = sessions.flatMap((m) => (m.ai?.challenges || []).map((c) => ({ ...c, projectId: m.projectId, date: m.date })));
  const openOnes = challenges.filter((c) => c.status !== "solved");

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,320px)", gap: 16, alignItems: "start" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <Section>
            <div style={{ display: "flex", gap: 9, flexWrap: "wrap", alignItems: "center" }}>
              <input className="inp" style={{ flex: 1, minWidth: 200 }} placeholder="Search every discussion — a part, a supplier, a person, a problem…" value={q} onChange={(e) => setQ(e.target.value)} />
              <select className="inp" style={{ width: 190 }} value={proj} onChange={(e) => setProj(e.target.value)}>
                <option value="">Every project</option>
                {projects.map((p) => <option key={p.id} value={p.projectId}>{p.projectId}</option>)}
              </select>
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
              <Pill color="var(--acc)">{sessions.length} session{sessions.length === 1 ? "" : "s"}</Pill>
              <Pill color="var(--green)">{challenges.length - openOnes.length} challenge{challenges.length - openOnes.length === 1 ? "" : "s"} beaten</Pill>
              {openOnes.length > 0 && <Pill color="var(--red)">{openOnes.length} still open</Pill>}
            </div>
          </Section>

          {shown.length === 0 ? (
            <Section>
              <Empty icon={Lightbulb} title={sessions.length ? "Nothing matches that" : "No discussions written up yet"}
                sub={sessions.length ? "Try a different word, or clear the project filter." : "Open a project and use its Brainstorming tab to type up a session. The AI keeps the challenge, how it was beaten, whose idea helped and what to do next — so the same argument never has to happen twice."} />
              {!sessions.length && <div style={{ marginTop: 10 }}><Btn small kind="ghost" icon={ArrowRight} onClick={() => setView("projects")}>Open a project</Btn></div>}
            </Section>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 11 }}>
              {shown.map((m) => <MomCard key={m.id} m={m} showProject />)}
            </div>
          )}
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <Section>
            <CardLabel right={<Award size={14} style={{ color: "var(--amber)" }} />}>Who is moving projects forward</CardLabel>
            {credit.length === 0
              ? <div style={{ fontSize: 12, color: "var(--txt3)", lineHeight: 1.6 }}>Once discussions are written up, whoever's ideas actually saved time, money or quality shows up here — scored on how much each one helped, not on how often they spoke.</div>
              : <>
                <IdeaBoard credit={credit} />
                <div style={{ fontSize: 10.5, color: "var(--txt3)", marginTop: 10, lineHeight: 1.55 }}>Scored 1–5 per idea on how much it actually helped, so one idea that saved a fortnight outweighs ten easy ones.</div>
              </>}
          </Section>

          {credit.slice(0, 3).map((c) => (
            <Section key={c.name} style={{ background: "var(--s2)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 7 }}>
                <Lightbulb size={13} style={{ color: "var(--purple)" }} />
                <span style={{ fontWeight: 700, fontSize: 12.5 }}>{c.name}</span>
                <Pill color="var(--purple)">{c.score}</Pill>
              </div>
              {c.examples.map((e, i) => (
                <div key={i} style={{ fontSize: 11.5, color: "var(--txt2)", lineHeight: 1.55, marginBottom: 5 }}>
                  <span style={{ fontFamily: MONO, fontSize: 10.5, color: "var(--txt3)" }}>{e.projectId}</span> · {e.idea}
                </div>
              ))}
            </Section>
          ))}

          {openOnes.length > 0 && (
            <Section>
              <CardLabel>Still unresolved</CardLabel>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {openOnes.slice(0, 8).map((c, i) => (
                  <div key={i} style={{ fontSize: 12, lineHeight: 1.55 }}>
                    <span style={{ fontFamily: MONO, fontSize: 10.5, color: "var(--txt3)" }}>{c.projectId}</span> · {c.problem}
                  </div>
                ))}
              </div>
            </Section>
          )}
        </div>
      </div>
    </div>
  );
}

/* ═══ SHELL — SIDEBAR, HEADER, TOASTS, APP ROOT ══════════════════════════ */
/* The menu is grouped by what you came here to do — the work of a project,
   the people, your own week, and the AI — rather than by one flat list where
   everything looked equally important. */
const NAV_GROUPS = [
  ["Projects", [
    { id: "projects", label: "Projects", icon: FolderPlus, admin: true },
    { id: "scrum", label: "Daily Scrum", icon: NotebookPen },
    { id: "mom", label: "Brainstorming Sessions", icon: Lightbulb },
  ]],
  ["Resources", [
    { id: "resources", label: "Resources", icon: Users },
  ]],
  ["Personal", [
    { id: "tasks", label: "My Projects & Tasks", icon: ListChecks },
    { id: "perf", label: "Performance & Training", icon: Gauge },
  ]],
  ["AI", [
    { id: "assistant", label: "Assistant", icon: Bot },
    { id: "memory", label: "System Memory", icon: Database, admin: true },
  ]],
];
const NAV = NAV_GROUPS.flatMap(([, items]) => items);
const TITLES = {
  assistant: ["Assistant", "Say it in plain words — it creates projects, staffs them, raises tasks, writes the scrum, remembers, and reads & writes Drive"],
  projects: ["Projects", "Add or create a project · hard gates on Project ID + both LLDs · open one for its plan, files and chat"],
  mom: ["Brainstorming Sessions", "Brainstorms, challenges and how they were beaten — kept so the same mistake is never made twice, and so good ideas get credited"],
  scrum: ["Daily Scrum", "Write it as it comes — AI turns it into assigned, time-boxed, if/else-aware tasks"],
  tasks: ["My Projects & Tasks", "Start → work window → AI-gated closure · branch stuck work back to scrum"],
  resources: ["Resources", "Team roster, availability, deployment & efficiency"],
  perf: ["Performance & Training", "PM KPIs with red alerts · daily work updates scored against the KPI · trainings"],
  memory: ["System Memory", "Templates, instructions, conversations, Drive sitemaps — injected into every AI call"],
};

/* Pre-app shell (loading / login) — carries the theme + CSS before the app mounts */
const Shell = ({ dark, children }) => (
  <div className="eb-root" style={{ ...(dark ? DARK : LIGHT), display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh", padding: 16 }}>
    <style>{CSS}</style>
    {children}
  </div>
);

/* ═══ LOGIN / SIGN-UP ═════════════════════════════════════════════════════
   Real Supabase email/password auth when Supabase is connected; a working demo
   login (any credentials, or pick a role) when it isn't. Always the front door. */
const SAMPLE_LOGIN = { email: "saurav@elecbits.in", pw: "Elecbits@2026" };

/* One door, not two.
   Asking somebody to know in advance whether they are "signing in" or
   "creating an account" is asking them a question only the database can
   answer — and getting it wrong is what produced "that email already has an
   account" on a screen with no way forward. So: they type their work email
   and a password and press Continue.

   Sign-in is tried first. If the credentials are refused we try to create the
   account; Supabase answers a sign-up for an existing email with an empty
   identities array and creates nothing, which tells us the email is real and
   the password was simply wrong — so we say that, and offer the reset. A
   password typo can never mint a stray account. */
function Login({ dark, onToggleTheme, demo, onDemoLogin, recovery, onNewPassword }) {
  const [email, setEmail] = useState(demo ? SAMPLE_LOGIN.email : "");
  const [pw, setPw] = useState(demo ? SAMPLE_LOGIN.pw : "");
  const [name] = useState("");   // the roster already knows who people are
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [wrongPw, setWrongPw] = useState(false);   // offer the reset only once it is the likely problem
  const [sent, setSent] = useState(false);
  const [linkDead, setLinkDead] = useState(false);

  // Arriving from a reset link that Supabase refused: say why, and put the
  // way out right under it.
  useEffect(() => {
    const e = authReturnError();
    if (e) { setErr(e); setLinkDead(true); }
  }, []);

  const netErr = (m) => /failed to fetch|networkerror|load failed|fetch/i.test(m);

  const submit = async () => {
    if (demo) { onDemoLogin("u-admin"); return; }
    const addr = email.trim().toLowerCase();
    if (!addr || !pw) return;
    setBusy(true); setErr(""); setMsg(""); setWrongPw(false);
    try {
      await signIn(addr, pw);                       // onAuthChange takes it from here
    } catch (e) {
      const m = e?.message || "Sign-in failed";
      if (netErr(m)) {
        setErr("Can't reach Supabase. Check VITE_SUPABASE_URL is your exact project URL, the project isn't paused, and a VPN or ad-blocker isn't blocking supabase.co.");
      } else if (/invalid login credentials|email not confirmed/i.test(m)) {
        try {
          const d = await signUp(addr, pw, name.trim());
          if (d?.user?.identities?.length === 0) {
            // The email exists. So this was the wrong password, not a new person.
            setWrongPw(true);
            setErr("That password doesn't match this email. Try again, or send yourself a reset link.");
          } else if (d?.session) {
            /* straight in */
          } else {
            setMsg(`Account created for ${addr}. Check that inbox for a confirmation link, then press Continue again — your password is still filled in.`);
          }
        } catch (e2) {
          const m2 = e2?.message || m;
          // The workspace is invite-only and this email is not on the roster.
          if (/not_invited|database error saving new user|unexpected_failure/i.test(m2))
            setErr(`${addr} isn't on the team roster, so there's no account to make. Ask a project manager to add you under Resources, then sign in with this same email.`);
          else if (/password/i.test(m2) && /(6|short|weak|least)/i.test(m2)) setErr("Pick a longer password — at least 6 characters.");
          else if (/valid email|invalid/i.test(m2)) setErr("That doesn't look like an email address.");
          else if (/rate|too many/i.test(m2)) setErr("Too many attempts just now. Wait a minute and try again.");
          else if (/signups? not allowed|disabled/i.test(m2)) setErr("New accounts are switched off for this workspace. Ask an admin to add you.");
          else { setWrongPw(true); setErr(m2); }
        }
      } else if (/rate|too many/i.test(m)) {
        setErr("Too many attempts just now. Wait a minute and try again.");
      } else {
        setErr(m);
      }
    }
    setBusy(false);
  };

  const sendReset = async () => {
    const addr = email.trim().toLowerCase();
    if (!addr) { setErr("Type your work email first."); return; }
    setBusy(true); setErr(""); setMsg("");
    try {
      await resetPassword(addr);
      setSent(true);
      setMsg(`Reset link sent to ${addr}. Open it on this device and you'll be asked to choose a new password.`);
    } catch (e) {
      const m = e?.message || "Couldn't send the reset link";
      setErr(netErr(m) ? "Can't reach Supabase to send that." : m);
    }
    setBusy(false);
  };

  /* Back from the reset email — pick the new password and carry straight on. */
  const [np, setNp] = useState("");
  const saveNew = async () => {
    if (np.length < 6) { setErr("At least 6 characters."); return; }
    setBusy(true); setErr("");
    try { await setPassword(np); onNewPassword?.(); }
    catch (e) { setErr(e?.message || "Couldn't set that password"); }
    setBusy(false);
  };
  if (recovery) {
    return (
      <Shell dark={dark}>
        <div className="fade card" style={{ width: "100%", maxWidth: 400, padding: 30 }}>
          <img src={elecbitsLogo} alt="Elecbits" style={{ ...logoChip(dark, 34), marginBottom: 14 }} />
          <div style={{ fontWeight: 800, fontSize: 16, marginBottom: 4 }}>Choose a new password</div>
          <div style={{ fontSize: 12.5, color: "var(--txt2)", marginBottom: 16 }}>You came in from a reset link. Set it once and you're straight into the workspace.</div>
          <Field label="New password"><PasswordInput value={np} onChange={setNp} onEnter={saveNew} placeholder="at least 6 characters" autoComplete="new-password" autoFocus /></Field>
          {err && <div style={{ fontSize: 12, color: "var(--red)", fontWeight: 600, marginTop: 10 }}>{err}</div>}
          <div style={{ marginTop: 14 }}><Btn icon={busy ? Loader2 : ArrowRight} disabled={busy || np.length < 6} onClick={saveNew} style={{ width: "100%" }}>{busy ? "Saving…" : "Save and continue"}</Btn></div>
        </div>
      </Shell>
    );
  }
  return (
    <Shell dark={dark}>
      <div className="fade card" style={{ width: "100%", maxWidth: 380, padding: 32, position: "relative" }}>
        <button onClick={onToggleTheme} title="Toggle theme" style={{ position: "absolute", top: 16, right: 16, width: 32, height: 32, borderRadius: 8, border: "1px solid var(--bdr)", background: "var(--s2)", color: "var(--txt2)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>{dark ? <Sun size={15} /> : <Moon size={15} />}</button>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center", marginBottom: 24 }}>
          <img src={elecbitsLogo} alt="Elecbits" style={{ ...logoChip(dark, 38), marginBottom: 10 }} />
          <div style={{ fontSize: 12.5, color: "var(--txt2)" }}>ODM · Project Management</div>
          <div style={{ fontSize: 12.5, color: "var(--txt3)", marginTop: 3 }}>{demo ? "Sign in to continue" : "Sign in, or sign up — same box"}</div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <Field label="Work email"><input className="inp" type="email" autoFocus autoComplete="username" value={email} onChange={(e) => { setEmail(e.target.value); setWrongPw(false); setSent(false); setErr(""); }} onKeyDown={(e) => e.key === "Enter" && submit()} placeholder="you@elecbits.in" /></Field>
          <Field label="Password"><PasswordInput value={pw} onChange={setPw} onEnter={submit} /></Field>
          {err && <div style={{ fontSize: 12, color: "var(--red)", fontWeight: 600, lineHeight: 1.5 }}>{err}</div>}
          {msg && <div style={{ fontSize: 12, color: "var(--green)", fontWeight: 600, lineHeight: 1.5 }}>{msg}</div>}
          <Btn icon={busy ? Loader2 : ArrowRight} disabled={busy || (!demo && (!email.trim() || !pw))} onClick={submit} style={{ width: "100%" }}>{busy ? "Please wait…" : demo ? "Sign in" : "Continue"}</Btn>
        </div>

        {!demo && (
          <div style={{ marginTop: 16, textAlign: "center" }}>
            <button onClick={sendReset} disabled={busy || sent}
              style={{ background: "none", border: "none", padding: 0, color: sent ? "var(--txt3)" : linkDead ? "var(--acc)" : "var(--txt2)", cursor: sent ? "default" : "pointer", fontSize: linkDead ? 13 : 12, fontWeight: linkDead ? 700 : 600 }}>
              {sent ? "Reset link sent — check your inbox" : linkDead ? "Send me a new reset link" : "Forgot your password?"}
            </button>
            {/* No sign-up tab: the same button makes the account if there is
                not one yet, so there is nothing here to choose between. */}
            <div style={{ marginTop: 10, fontSize: 11.5, color: "var(--txt3)", lineHeight: 1.55 }}>
              First time? Use your work email and pick a password.
            </div>
          </div>
        )}

        {demo && (<>
          <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "20px 0 12px" }}>
            <div style={{ flex: 1, height: 1, background: "var(--bdr)" }} /><span style={{ fontSize: 11, color: "var(--txt3)", fontWeight: 600 }}>or jump in as</span><div style={{ flex: 1, height: 1, background: "var(--bdr)" }} />
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
            {SEED_USERS.filter((u) => u.role !== "engineer" && u.id !== "u-admin").slice(0, 8).map((u) => (
              <button key={u.id} title={u.email} onClick={() => onDemoLogin(u.id)} style={{ display: "flex", alignItems: "center", gap: 7, padding: "6px 11px", borderRadius: 99, border: "1px solid var(--bdr)", background: "var(--s1)", cursor: "pointer" }}>
                <AvatarDot user={u} size={20} /><span style={{ fontSize: 12, fontWeight: 600 }}>{u.name}</span>
              </button>
            ))}
          </div>
          <div style={{ marginTop: 16, fontSize: 11.5, color: "var(--txt3)", lineHeight: 1.6, textAlign: "center" }}>Demo mode — any credentials work. Connect Supabase for real accounts.</div>
        </>)}
      </div>
    </Shell>
  );
}

/* Shown when Supabase env vars are present but the client couldn't start —
   turns the silent "no login / demo" confusion into a named, fixable problem. */
function SupabaseConfigError({ dark, onToggleTheme }) {
  return (
    <Shell dark={dark}>
      <div className="fade card" style={{ width: "100%", maxWidth: 480, padding: 28, position: "relative" }}>
        <button onClick={onToggleTheme} style={{ position: "absolute", top: 16, right: 16, width: 32, height: 32, borderRadius: 8, border: "1px solid var(--bdr)", background: "var(--s2)", color: "var(--txt2)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>{dark ? <Sun size={15} /> : <Moon size={15} />}</button>
        <img src={elecbitsLogo} alt="Elecbits" style={{ ...logoChip(dark, 26), marginBottom: 12 }} />
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
          <AlertTriangle size={18} style={{ color: "var(--amber)" }} />
          <div style={{ fontWeight: 800, fontSize: 16 }}>Supabase isn't configured correctly</div>
        </div>
        <div style={{ fontSize: 13, color: "var(--txt2)", lineHeight: 1.6, marginBottom: 14 }}>Your Supabase environment variables are set, but the client couldn't start — so the login screen is off. Fix the value in Vercel and redeploy.</div>
        <div style={{ fontSize: 11, fontWeight: 700, color: "var(--txt2)", textTransform: "uppercase", letterSpacing: ".05em", marginBottom: 5 }}>Problem</div>
        <pre style={{ margin: "0 0 8px", padding: 10, background: "var(--s2)", border: "1px solid var(--bdr)", borderRadius: 8, fontSize: 12, whiteSpace: "pre-wrap", color: "var(--red)" }}>{supabaseInitError || "Supabase client failed to initialise."}</pre>
        <div style={{ fontSize: 11, fontWeight: 700, color: "var(--txt2)", textTransform: "uppercase", letterSpacing: ".05em", marginBottom: 5 }}>URL the app used</div>
        <pre style={{ margin: "0 0 14px", padding: 10, background: "var(--s2)", border: "1px solid var(--bdr)", borderRadius: 8, fontSize: 12, whiteSpace: "pre-wrap", fontFamily: MONO, color: "var(--txt)" }}>{supabaseUrl || "(empty)"}</pre>
        <div style={{ fontSize: 12.5, color: "var(--txt2)", lineHeight: 1.7 }}>
          In Vercel → Environment Variables, <b style={{ color: "var(--txt)" }}>VITE_SUPABASE_URL</b> must be exactly<br />
          <span style={{ fontFamily: MONO, color: "var(--acc)" }}>https://&lt;ref&gt;.supabase.co</span><br />
          — no quotes, no spaces, no trailing slash, and <b style={{ color: "var(--txt)" }}>not</b> the dashboard link. Get it from Supabase → Settings → API → Project URL. Then redeploy.
        </div>
      </div>
    </Shell>
  );
}

export default function App() {
  const [booted, setBooted] = useState(false);
  const [dark, setDark] = useState(false);
  const [me, setMe] = useState("u-admin");
  const [session, setSession] = useState(null);
  const [authChecked, setAuthChecked] = useState(!supabaseEnabled);
  const [recovery, setRecovery] = useState(false);
  const [profiles, setProfiles] = useState(null);
  const [demoUser, setDemoUser] = useState(() => { try { return localStorage.getItem("pms-demo-user") || ""; } catch { return ""; } });
  const demoLogin = useCallback((id) => { setDemoUser(id); setMe(id); try { localStorage.setItem("pms-demo-user", id); } catch { } }, []);
  const demoLogout = useCallback(() => { setDemoUser(""); try { localStorage.removeItem("pms-demo-user"); } catch { } }, []);
  const [view, setView] = useState("assistant");
  const [projects, setProjects] = useState(SEED_PROJECTS);
  const [clients, setClients] = useState(SEED_CLIENTS);
  const [notes, setNotes] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [kpiLog, setKpiLog] = useState([]);
  const [workUpdates, setWorkUpdates] = useState([]);
  const [trainings, setTrainings] = useState([]);
  const [memory, setMemory] = useState(SEED_MEMORY);
  const [syncLog, setSyncLog] = useState([]);
  const [assistantLog, setAssistantLog] = useState([]);   // day-wise, name-stamped, persisted
  const [toasts, setToasts] = useState([]);
  const [now, setNow] = useState(Date.now());
  const [customRoster, setCustomRoster] = useState(null);
  const users = supabaseEnabled ? (profiles || []) : (customRoster || SEED_USERS);
  const my = users.find((u) => u.id === me);
  const isAdmin = my?.role === "superadmin";

  const toast = useCallback((msg, kind = "blue") => { const id = uid(); setToasts((t) => [...t, { id, msg, kind }]); setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3400); }, []);
  const sheetSync = useCallback((target, detail) => {
    setSyncLog((x) => [{ id: uid(), at: new Date().toISOString(), target, detail }, ...x].slice(0, 60));
    // Real Google Drive / Sheets write via the Supabase Edge Function, when configured.
    if (DRIVE_SYNC_URL) {
      fetch(DRIVE_SYNC_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ target, detail, at: new Date().toISOString() }) }).catch(() => {});
    }
  }, []);

  /* ── shared-workspace sync ─────────────────────────────────────────────────
     With Supabase on, every save READS the server first and MERGES before
     writing, and a 30-second poll merges other people's saves in. Nobody's
     save can erase anybody else's work any more — the old behaviour wrote
     this browser's whole copy over the blob, so the second person to save
     silently destroyed the first person's.

     knownRef  — ids this browser has confirmed on the server
     baseRef   — each item as of the last sync, so an incoming change can be
                 told apart from this browser's own unsaved edit
     cloudOk   — false until the server has actually been read; while false,
                 nothing is written, so a failed boot can't overwrite anyone */
  const knownRef = useRef({});
  const baseRef = useRef({});
  const cloudOkRef = useRef(!supabaseEnabled);
  const savingRef = useRef(false);
  const cloudGet = useCallback(async (key) => {
    // Straight to the table — window.storage falls back to localStorage on
    // failure, and a stale local copy fed into the merge would read as "the
    // server deleted these" and drop live rows.
    const { data, error } = await supabase.from("app_kv").select("value").eq("key", key).maybeSingle();
    if (error) throw error;
    return data?.value ? JSON.parse(data.value) : null;
  }, []);
  const cloudSet = useCallback(async (key, value) => {
    const { error } = await supabase.from("app_kv").upsert({ key, value, updated_at: new Date().toISOString() });
    if (error) throw error;
    try { localStorage.setItem(key, value); } catch (e) { }   // offline mirror
  }, []);
  const applyMerged = useCallback((st, names) => {
    const S = { projects: setProjects, clients: setClients, notes: setNotes, tasks: setTasks,
      kpiLog: setKpiLog, workUpdates: setWorkUpdates, trainings: setTrainings, memory: setMemory,
      syncLog: setSyncLog, assistantLog: setAssistantLog, roster: setCustomRoster };
    for (const n of names) if (S[n]) S[n](st[n]);
  }, []);

  /* boot from persistent storage — with Supabase on, wait for the session so
     an RLS-blocked read can't come back "empty" and boot the app onto seeds */
  const bootRan = useRef(false);
  useEffect(() => { if (bootRan.current) return; if (supabaseEnabled && !session) return; bootRan.current = true; (async () => {
    if (supabaseEnabled) {
      let sa = null, sb = null, ok = false;
      for (let i = 0; i < 3 && !ok; i++) {
        try { [sa, sb] = await Promise.all([cloudGet("pms-v1-a"), cloudGet("pms-v1-b")]); ok = true; }
        catch (e) { await new Promise((r) => setTimeout(r, 800 * (i + 1))); }
      }
      if (ok) {
        if (sa?.projects) setProjects(sa.projects); else setProjects([]);   // a real workspace never
        if (sa?.clients) setClients(sa.clients); else setClients([]);       // starts on demo seeds
        if (sa?.notes) setNotes(sa.notes); if (sa?.tasks) setTasks(sa.tasks);
        if (sb?.kpiLog) setKpiLog(sb.kpiLog); if (sb?.workUpdates) setWorkUpdates(sb.workUpdates);
        if (sb?.trainings) setTrainings(sb.trainings); if (sb?.memory) setMemory(sb.memory);
        if (sb?.syncLog) setSyncLog(sb.syncLog); if (sb?.roster) setCustomRoster(sb.roster);
        if (sb?.assistantLog) setAssistantLog(sb.assistantLog);
        knownRef.current = idsOf(sa, sb); baseRef.current = baseOf(sa, sb);
        cloudOkRef.current = true;
      } else {
        // Server unreadable: show the offline mirror, but write NOTHING until
        // a later read succeeds — the poll below keeps trying.
        try { const a = localStorage.getItem("pms-v1-a"); if (a) { const d = JSON.parse(a); if (d.projects) setProjects(d.projects); if (d.clients) setClients(d.clients); if (d.notes) setNotes(d.notes); if (d.tasks) setTasks(d.tasks); } } catch (e) { }
        try { const b = localStorage.getItem("pms-v1-b"); if (b) { const d = JSON.parse(b); if (d.kpiLog) setKpiLog(d.kpiLog); if (d.workUpdates) setWorkUpdates(d.workUpdates); if (d.trainings) setTrainings(d.trainings); if (d.memory) setMemory(d.memory); if (d.syncLog) setSyncLog(d.syncLog); if (d.roster) setCustomRoster(d.roster); if (d.assistantLog) setAssistantLog(d.assistantLog); } } catch (e) { }
        toast("Couldn't reach the database — showing your last local copy, saving is paused", "amber");
      }
    } else {
      try { const a = await window.storage.get("pms-v1-a"); if (a?.value) { const d = JSON.parse(a.value); if (d.projects) setProjects(d.projects); if (d.clients) setClients(d.clients); if (d.notes) setNotes(d.notes); if (d.tasks) setTasks(d.tasks); } } catch (e) { }
      try { const b = await window.storage.get("pms-v1-b"); if (b?.value) { const d = JSON.parse(b.value); if (d.kpiLog) setKpiLog(d.kpiLog); if (d.workUpdates) setWorkUpdates(d.workUpdates); if (d.trainings) setTrainings(d.trainings); if (d.memory) setMemory(d.memory); if (d.syncLog) setSyncLog(d.syncLog); if (d.roster) setCustomRoster(d.roster); if (d.assistantLog) setAssistantLog(d.assistantLog); } } catch (e) { }
    }
    setBooted(true);
  })(); }, [session, cloudGet, toast]);

  /* debounced save — merge first, then write, then mirror to real tables */
  useEffect(() => { if (!booted) return; const t = setTimeout(async () => {
    const local = { projects, clients, notes, tasks, kpiLog, workUpdates, trainings, memory, syncLog, roster: customRoster, assistantLog };
    if (supabaseEnabled) {
      if (!cloudOkRef.current || savingRef.current) return;   // never write blind
      savingRef.current = true;
      try {
        const [sa, sb] = await Promise.all([cloudGet("pms-v1-a"), cloudGet("pms-v1-b")]);
        const res = mergeWorkspace(local, sa, sb, knownRef.current, baseRef.current);
        if (res.changed.length) applyMerged(res.state, res.changed);
        await cloudSet("pms-v1-a", JSON.stringify(blobA(res.state)));
        await cloudSet("pms-v1-b", JSON.stringify(blobB(res.state)));
        // Only after the server confirms the write — otherwise the next merge
        // would treat rows the server never received as someone's deletions.
        knownRef.current = res.serverIds; baseRef.current = res.baseAfter;
        try { await syncAll(supabase, { ...res.state, assistantLog: (res.state.assistantLog || []).filter((m) => !m.confirm) }); } catch (e) { }
      } catch (e) { /* unreadable/unwritable this cycle — state is intact, the next save retries */ }
      finally { savingRef.current = false; }
    } else {
      try { await window.storage.set("pms-v1-a", JSON.stringify({ projects, clients, notes, tasks })); } catch (e) { }
      try { await window.storage.set("pms-v1-b", JSON.stringify({ kpiLog, workUpdates, trainings, memory, syncLog, roster: customRoster, assistantLog: assistantLog.slice(-200).filter((m) => !m.confirm) })); } catch (e) { }
    }
  }, 700); return () => clearTimeout(t); }, [booted, projects, clients, notes, tasks, kpiLog, workUpdates, trainings, memory, syncLog, customRoster, assistantLog, cloudGet, cloudSet, applyMerged]);

  /* the poll — other people's saves arrive without a reload */
  const pollState = useRef(null);
  pollState.current = { projects, clients, notes, tasks, kpiLog, workUpdates, trainings, memory, syncLog, roster: customRoster, assistantLog };
  useEffect(() => {
    if (!supabaseEnabled || !booted || !session) return;
    const pull = async () => {
      if (savingRef.current) return;
      try {
        const [sa, sb] = await Promise.all([cloudGet("pms-v1-a"), cloudGet("pms-v1-b")]);
        const res = mergeWorkspace(pollState.current, sa, sb, knownRef.current, baseRef.current);
        if (res.changed.length) applyMerged(res.state, res.changed);
        knownRef.current = idsOf(sa, sb); baseRef.current = baseOf(sa, sb);
        if (!cloudOkRef.current) { cloudOkRef.current = true; toast("Back online — saving again", "green"); }
      } catch (e) { }
    };
    const iv = setInterval(pull, 30000);
    window.addEventListener("focus", pull);
    return () => { clearInterval(iv); window.removeEventListener("focus", pull); };
  }, [booted, session, cloudGet, applyMerged, toast]);
  /* auth session (Supabase configured only) */
  useEffect(() => {
    if (!supabaseEnabled) return;
    let sub;
    (async () => {
      try { setSession(await getSession()); } catch (e) { }
      setAuthChecked(true);
      sub = onAuthChange((s, event) => {
        setSession(s);
        // Arriving from a reset email: Supabase signs them in, but the point
        // of the visit is to choose a new password — so ask for it before
        // dropping them into the workspace.
        if (event === "PASSWORD_RECOVERY") setRecovery(true);
      });
    })();
    return () => sub?.unsubscribe?.();
  }, []);
  /* load the roster + resolve my identity once signed in */
  useEffect(() => {
    if (!supabaseEnabled) return;
    if (!session) { setProfiles(null); return; }
    fetchProfiles().then((ps) => {
      setProfiles(ps);
      // A person's roster id and their login are two different things once a
      // resource can exist before its account does — match on the login.
      const authId = session.user?.id;
      const mine = ps.find((u) => u.authId === authId)
        || ps.find((u) => u.id === authId)
        || (session.user?.email ? ps.find((u) => (u.email || "").toLowerCase() === session.user.email.toLowerCase()) : null);
      if (mine) setMe(mine.id);
    }).catch(() => setProfiles([]));
  }, [session]);
  /* ticking clock only where countdowns live */
  useEffect(() => { if (view !== "scrum" && view !== "tasks") return; const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, [view]);
  /* role gating */
  useEffect(() => { const item = NAV.find((n) => n.id === view); if (item?.admin && !isAdmin) setView("tasks"); }, [me]); // eslint-disable-line

  const resetAll = useCallback(async () => {
    try { await window.storage.delete("pms-v1-a"); } catch (e) { }
    try { await window.storage.delete("pms-v1-b"); } catch (e) { }
    setProjects(SEED_PROJECTS); setClients(SEED_CLIENTS); setNotes([]); setTasks([]); setKpiLog([]); setWorkUpdates([]); setTrainings([]); setMemory(SEED_MEMORY); setSyncLog([]); setCustomRoster(null); setAssistantLog([]);
    toast("Everything reset to seed data", "amber");
  }, [toast]);

  /* ── roster mutators (Resources → Add/Edit/Remove). Local state always;
     best-effort Supabase profiles write when connected. ── */
  const applyRoster = useCallback((fn) => { if (supabaseEnabled) setProfiles((ps) => fn(ps || [])); else setCustomRoster((r) => fn(r || SEED_USERS)); }, []);
  const dbProfileUpsert = async (u) => {
    if (!supabaseEnabled) return null;
    // Persist the FULL resource record — dept, role/function, skills and
    // capacity, not just the display fields, or they vanish on refresh.
    const row = {
      id: u.id, email: u.email || null, name: u.name, role: u.role, title: u.title, color: u.color,
      dept: u.dept || null,
      resource_role: u.resourceRole || null,
      skills: u.skills || [],
      max_projects: u.maxProjects || null,
      project_tags: u.projectTags || [],
    };
    // auth_id is only there once the workspace has run fix-resource-creation.sql.
    // Send it when we know it, and drop it if the column does not exist yet, so
    // an un-migrated workspace still saves the rest of the record.
    let { error } = await supabase.from("profiles").upsert({ ...row, auth_id: u.authId || null });
    if (error && /auth_id/.test(error.message || "")) {
      ({ error } = await supabase.from("profiles").upsert(row));
    }
    return error;
  };
  /* Create (or reset) a real login for a roster entry, from the Add Resource
     form. The heavy lifting happens in the `admin-users` Edge Function — a
     password can only be set with the service-role key, which never reaches
     the browser. Returns "" on a fresh login, "reset" when an existing one had
     its password replaced, or a human-readable error. */
  const ADMIN_USERS_URL = import.meta.env.VITE_ADMIN_USERS_URL || (supabaseUrl ? `${supabaseUrl}/functions/v1/admin-users` : "");
  const provisionLogin = useCallback(async (email, password, name) => {
    if (!supabaseEnabled) return "Logins need Supabase configured — in demo mode there is nothing to sign in to.";
    try {
      const s = await getSession();
      if (!s?.access_token) return "Your own session has expired — sign in again first.";
      const r = await fetch(ADMIN_USERS_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: supabaseAnonKey, Authorization: `Bearer ${s.access_token}` },
        body: JSON.stringify({ email, password, name }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || d.error) {
        return d.error || (r.status === 404
          ? "The admin-users function isn't deployed yet — deploy supabase/functions/admin-users in Supabase (and set VITE_ADMIN_USERS_URL if you name it differently)."
          : `Couldn't create the login (${r.status}).`);
      }
      return d.created ? "" : "reset";
    } catch (e) {
      return "Couldn't reach the login service — check the connection and try again.";
    }
  }, [ADMIN_USERS_URL]);

  const addUser = useCallback(async (u) => {
    applyRoster((rs) => [...rs, u]);
    const err = await dbProfileUpsert(u);
    if (err) toast(rosterFailure(err), "amber");
    else toast(`${u.name} added to the team${u.email ? ` — they get in by signing up with ${u.email}` : ""}`, "green");
  }, [applyRoster, toast]);
  const updateUser = useCallback(async (u) => {
    applyRoster((rs) => rs.map((x) => (x.id === u.id ? { ...x, ...u } : x)));
    const err = await dbProfileUpsert(u);
    if (err) toast(rosterFailure(err), "amber");
    else toast(`${u.name} updated`, "green");
  }, [applyRoster, toast]);
  const removeUser = useCallback(async (id, nameLabel) => {
    applyRoster((rs) => rs.filter((x) => x.id !== id));
    setProjects((ps) => ps.map((p) => ({ ...p, team: (p.team || []).filter((t) => t.userId !== id) })));
    if (supabaseEnabled) { try { await supabase.from("profiles").delete().eq("id", id); } catch (e) { } }
    toast(`${nameLabel || "Resource"} removed — unassigned from all projects`, "amber");
  }, [applyRoster, toast]);

  const ctx = { users, me, setMe, view, setView, projects, setProjects, clients, setClients, notes, setNotes, tasks, setTasks, kpiLog, setKpiLog, workUpdates, setWorkUpdates, trainings, setTrainings, memory, setMemory, syncLog, setSyncLog, assistantLog, setAssistantLog, toast, sheetSync, now, resetAll, addUser, updateUser, removeUser, provisionLogin };
  const visGroups = NAV_GROUPS
    .map(([title, items]) => [title, items.filter((n) => !n.admin || isAdmin)])
    .filter(([, items]) => items.length);
  const [t1, t2] = TITLES[view] || ["", ""];

  if (supabaseConfigured && !supabaseEnabled) return <SupabaseConfigError dark={dark} onToggleTheme={() => setDark(!dark)} />;
  if (supabaseEnabled && !authChecked) return <Shell dark={dark}><div style={{ display: "flex", alignItems: "center", gap: 10, color: "var(--txt2)" }}><Loader2 className="spin" size={18} /> Checking your session…</div></Shell>;
  if (supabaseEnabled && (!session || recovery)) {
    return <Login dark={dark} onToggleTheme={() => setDark(!dark)} recovery={recovery && !!session} onNewPassword={() => setRecovery(false)} />;
  }
  if (supabaseEnabled && !profiles) return <Shell dark={dark}><div style={{ display: "flex", alignItems: "center", gap: 10, color: "var(--txt2)" }}><Loader2 className="spin" size={18} /> Loading your workspace…</div></Shell>;
  if (!supabaseEnabled && !demoUser) return <Login dark={dark} demo onDemoLogin={demoLogin} onToggleTheme={() => setDark(!dark)} />;
  if (!booted) return (
    <div className="eb-root" style={{ ...(dark ? DARK : LIGHT), display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh" }}>
      <style>{CSS}</style>
      <div style={{ display: "flex", alignItems: "center", gap: 10, color: "var(--txt2)" }}><Loader2 className="spin" size={18} /> Loading the ODM system…</div>
    </div>
  );
  return (
    <Ctx.Provider value={ctx}>
      <div className="eb-root" style={{ ...(dark ? DARK : LIGHT), display: "flex", minHeight: "100vh" }}>
        <style>{CSS}</style>
        <aside className="eb-side" style={{ width: 234, flexShrink: 0, borderRight: "1px solid var(--bdr)", background: "var(--s1)", display: "flex", flexDirection: "column", position: "sticky", top: 0, height: "100vh" }}>
          <div style={{ padding: "18px 16px 14px", borderBottom: "1px solid var(--bdr)" }}>
            <img src={elecbitsLogo} alt="Elecbits" style={logoChip(dark, 26)} />
            <div style={{ fontSize: 10.5, color: "var(--txt2)", marginTop: 7, fontWeight: 600, letterSpacing: ".03em", textTransform: "uppercase" }}>ODM · Project Management</div>
          </div>
          <nav style={{ padding: 10, display: "flex", flexDirection: "column", gap: 3, flex: 1, overflowY: "auto" }}>
            {visGroups.map(([title, items], gi) => (
              <div key={title} style={{ marginTop: gi ? 12 : 2 }}>
                <div style={{ fontSize: 10, fontWeight: 800, color: "var(--txt3)", textTransform: "uppercase", letterSpacing: ".09em", padding: "0 10px 6px" }}>{title}</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                  {items.map((n) => (
                    <div key={n.id} data-nav={n.id} className={`navItem${view === n.id ? " on" : ""}`} onClick={() => setView(n.id)}>
                      <n.icon size={16} /> {n.label}
                      {n.admin && <Shield size={11} style={{ marginLeft: "auto", opacity: 0.5 }} />}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </nav>
          <div style={{ padding: 13, borderTop: "1px solid var(--bdr)", display: "flex", alignItems: "center", gap: 9 }}>
            <AvatarDot user={my} size={30} />
            <div style={{ minWidth: 0 }}><div style={{ fontWeight: 700, fontSize: 12.5, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{my?.name}</div><div style={{ fontSize: 10.5, color: "var(--txt2)" }}>{my?.title}</div></div>
          </div>
        </aside>
        <main style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
          <header style={{ padding: "14px 22px", borderBottom: "1px solid var(--bdr)", background: "var(--s1)", display: "flex", alignItems: "center", gap: 12, position: "sticky", top: 0, zIndex: 50, flexWrap: "wrap" }}>
            <div style={{ minWidth: 200, flex: 1 }}>
              <div style={{ fontWeight: 800, fontSize: 16, letterSpacing: "-.01em" }}>{t1}</div>
              <div style={{ fontSize: 11.5, color: "var(--txt2)", marginTop: 1 }}>{t2}</div>
            </div>
            <select className="inp eb-sideM" style={{ width: 170, display: "none" }} value={view} onChange={(e) => setView(e.target.value)}>
              {visGroups.map(([title, items]) => (
                <optgroup key={title} label={title}>
                  {items.map((n) => <option key={n.id} value={n.id}>{n.label}</option>)}
                </optgroup>
              ))}
            </select>
            <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
              {(!supabaseEnabled || isAdmin) && users.length > 0 && (<>
                <span style={{ fontSize: 11, color: "var(--txt3)", fontWeight: 700, textTransform: "uppercase", letterSpacing: ".05em" }}>{supabaseEnabled ? "View as" : "Viewing as"}</span>
                <select className="inp" style={{ width: 168 }} value={me} onChange={(e) => setMe(e.target.value)}>
                  {users.map((u) => <option key={u.id} value={u.id}>{u.name} · {u.role === "superadmin" ? "Admin" : u.role === "dept_head" ? "Dept Head" : u.role.toUpperCase()}</option>)}
                </select>
              </>)}
              {supabaseEnabled && <Btn small kind="ghost" onClick={async () => { await signOut(); }}>Sign out</Btn>}
              {!supabaseEnabled && <Btn small kind="ghost" onClick={demoLogout}>Sign out</Btn>}
              {!supabaseEnabled && <span title="No Supabase detected in this build — running on local demo data. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in Vercel and redeploy with a fresh build."><Pill color="var(--amber)"><Database size={10} /> Demo</Pill></span>}
              <button onClick={() => setDark(!dark)} style={{ width: 34, height: 34, borderRadius: 8, border: "1px solid var(--bdr)", background: "var(--s2)", color: "var(--txt2)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>{dark ? <Sun size={15} /> : <Moon size={15} />}</button>
            </div>
          </header>
          <div style={{ flex: 1, padding: 22, maxWidth: 1120, width: "100%", margin: "0 auto" }}>
            {view === "assistant" && <AssistantModule />}
            {view === "projects" && <ProjectsModule />}
            {view === "scrum" && <ScrumModule />}
            {view === "tasks" && <TasksModule />}
            {view === "mom" && <MomModule />}
            {view === "resources" && <ResourcesModule />}
            {view === "perf" && <PerfModule />}
            {view === "memory" && <MemoryModule />}
          </div>
        </main>
        {view !== "assistant" && <WorkspaceChat />}
        <div style={{ position: "fixed", bottom: 18, right: 18, display: "flex", flexDirection: "column", gap: 8, zIndex: 2000 }}>
          {toasts.map((t) => (
            <div key={t.id} className="fade" style={{ padding: "10px 15px", borderRadius: 10, background: "var(--s1)", border: `1px solid var(--${t.kind === "green" ? "green" : t.kind === "amber" ? "amber" : t.kind === "red" ? "red" : "acc"})`, boxShadow: "0 8px 26px rgba(0,0,0,.25)", fontSize: 12.5, fontWeight: 600, display: "flex", alignItems: "center", gap: 8, maxWidth: 340 }}>
              {t.kind === "green" ? <CheckCircle2 size={14} style={{ color: "var(--green)" }} /> : t.kind === "amber" ? <AlertTriangle size={14} style={{ color: "var(--amber)" }} /> : <RefreshCw size={14} style={{ color: "var(--acc)" }} />}
              {t.msg}
            </div>
          ))}
        </div>
      </div>
    </Ctx.Provider>
  );
}
