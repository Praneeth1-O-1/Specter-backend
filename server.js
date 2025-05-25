const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const multer = require("multer");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { Pinecone } = require("@pinecone-database/pinecone");
const fs = require("fs").promises; // Use fs.promises for async file operations
const path = require("path");
const session = require("express-session");
// const MongoStore = require('connect-mongo'); // Uncomment and install for production sessions

// Destructure functions from fileupload and embed.
// Ensure these paths are correct relative to your server.js
const { extractTextFromPDF, reviewContract } = require("./fileupload");
const { embedAndUpsertChunks } = require("./embed");

require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 5000;

// --- Global AI Model Initialization (for efficiency) ---
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const embedModel = genAI.getGenerativeModel({ model: "embedding-001" });
const queryModel = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

// --- Pinecone Initialization ---
const pinecone = new Pinecone({
  apiKey: process.env.PINECONE_API_KEY,
  // Add environment property if your Pinecone setup requires it
  // environment: process.env.PINECONE_ENVIRONMENT,
});

// --- Middleware ---
// CORS Configuration: IMPORTANT for production!
// Replace 'http://localhost:3000' with your actual frontend URL.
// In production, ensure this is locked down to your domain.
app.use(
  cors({
    origin: ["http://localhost:3000", "http://your-frontend-domain.com"], // Add your actual frontend domains
    methods: ["GET", "POST", "PUT", "DELETE"],
    credentials: true, // If your frontend needs to send cookies/sessions
  })
);
app.use(express.json());

// Session Middleware
app.use(
  session({
    secret: process.env.SESSION_SECRET, // A strong, unique secret
    resave: false, // Don't save session if unmodified
    saveUninitialized: true, // Save new but uninitialized sessions
    // Set secure: true in production if served over HTTPS
    cookie: { secure: process.env.NODE_ENV === "production" },
    // For production, use a persistent session store like connect-mongo:
    // store: MongoStore.create({ mongoUrl: process.env.MONGO_URI, ttl: 14 * 24 * 60 * 60 }) // 14 days
  })
);

// --- MongoDB Connection ---
mongoose
  .connect(process.env.MONGO_URI)
  .then(() => console.log("✅ MongoDB Connected"))
  .catch((err) => console.error("❌ MongoDB Connection Error:", err));

// --- Multer Setup for File Uploads ---
const uploadDir = "uploads/";
// Ensure the uploads directory exists
fs.mkdir(uploadDir, { recursive: true }).catch(console.error);

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    // Sanitize filename or use a unique ID to prevent path traversal/overwrite issues
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + "-" + file.originalname);
  },
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // Limit file size to 10MB
  fileFilter: (req, file, cb) => {
    // Only allow PDF files
    if (file.mimetype === "application/pdf") {
      cb(null, true);
    } else {
      cb(new Error("Only PDF files are allowed!"), false);
    }
  },
});

// --- Routes ---

app.post("/getVun", async (req, res) => {
  // Correctly get userQuery from request body
  const userQuery = req.body.query; // Expecting the query to be in req.body.query

  try {
    if (!userQuery) {
      return res.status(400).json({ success: false, error: "Query is required." });
    }

    // IMPORTANT: embedAndUpsertChunks should NOT be called here with the user query.
    // It's for ingesting documents into Pinecone, not for handling user queries.
    // Ensure your document ingestion process calls embedAndUpsertChunks separately.

    const embedResponse = await embedModel.embedContent({
      content: { parts: [{ text: userQuery }] },
    });
    const queryEmbedding = embedResponse.embedding.values;

    let queryResult;
    try {
      const index = pinecone.index(process.env.PINECONE_INDEX_NAME);
      queryResult = await index.query({
        vector: queryEmbedding,
        topK: 5, // Retrieve top 5 relevant chunks
        includeMetadata: true, // We need the text from metadata
        // includeValues: true, // Only include if you need the actual embeddings back
      });
    } catch (pineconeError) {
      console.error("❌ Pinecone query error:", pineconeError);
      return res.status(500).json({
        success: false,
        error: "Error querying knowledge base",
        details: pineconeError.message, // Provide error details for debugging
      });
    }

    let context = "";
    if (queryResult.matches && queryResult.matches.length > 0) {
      context = queryResult.matches
        .map((match) => {
          // In production, consider if you want to log full metadata or only specific parts.
          // console.log("Retrieved metadata:", match.metadata);
          return match.metadata.text; // Assuming the relevant text is stored in metadata.text
        })
        .join("\n\n"); // Join context pieces with double newlines for readability
    }

    // console.log("Context for Gemini:", context); // For debugging, remove/configure in production

    // Improved prompt for strict JSON output
    const prompt = `Answer the following question based on the provided context.
Your response MUST be a valid JSON object. Do not include any other text, preambles, or explanations. Only the JSON object.
Strictly adhere to the following JSON format. If a field is not applicable, use an empty string or null as its value, but keep the structure:
{"document_name": "document name here", "summary": "summary here", "sections": [{"title": "title here", "description": "description", "vulnerabilities": [{"issue": "issue here", "risk_level": "risklevel here", "details": "details here"}]}]}

Context:\n${context}\n\nQuestion: ${userQuery}`;

    const geminiResponse = await queryModel.generateContent(prompt);
    const geminiText = geminiResponse.response.text();

    console.log("Raw Gemini Response (getVun):", geminiText); // Keep for debugging JSON parsing issues

    let structured_json;
    try {
      // Clean and parse the JSON. Use .trim() to remove leading/trailing whitespace.
      const cleanedJsonText = geminiText.replace(/```json\n|\n```/g, "").trim();
      structured_json = JSON.parse(cleanedJsonText);
    } catch (jsonError) {
      console.error("❌ Failed to parse Gemini response as JSON (getVun):", jsonError);
      console.error("Raw Gemini text that failed parsing:", geminiText);
      return res.status(500).json({
        success: false,
        error: "Failed to process AI response. Invalid JSON format from AI.",
        details: jsonError.message,
        ai_response_raw: geminiText, // Send raw AI response for debugging
      });
    }

    // console.log("Parsed Structured JSON (getVun):", structured_json); // For debugging
    res.json({ success: true, response: structured_json });
  } catch (error) {
    console.error("❌ Error handling /getVun request:", error);
    res
      .status(500)
      .json({ success: false, error: "Server error during vulnerability query.", details: error.message });
  }
});

app.post("/getEmail", async (req, res) => {
  const userQuery = req.body.query;

  try {
    if (!userQuery) {
      return res.status(400).json({ success: false, error: "Query is required." });
    }

    // IMPORTANT: embedAndUpsertChunks should NOT be called here with the user query.
    // It's for ingesting documents into Pinecone, not for handling user queries.

    const embedResponse = await embedModel.embedContent({
      content: { parts: [{ text: userQuery }] },
    });
    const queryEmbedding = embedResponse.embedding.values;

    let queryResult;
    try {
      const index = pinecone.index(process.env.PINECONE_INDEX_NAME);
      queryResult = await index.query({
        vector: queryEmbedding,
        topK: 5,
        includeMetadata: true,
      });
    } catch (pineconeError) {
      console.error("❌ Pinecone query error:", pineconeError);
      return res.status(500).json({
        success: false,
        error: "Error querying knowledge base for email generation",
        details: pineconeError.message,
      });
    }

    let context = "";
    if (queryResult.matches && queryResult.matches.length > 0) {
      context = queryResult.matches
        .map((match) => {
          // console.log("Retrieved metadata:", match.metadata);
          return match.metadata.text;
        })
        .join("\n\n");
    }

    // console.log("Context for Gemini:", context); // For debugging

    // Improved prompt for strict JSON output
    const prompt = `Generate an email based on the user's request and the provided context.
Your response MUST be a valid JSON object. Do not include any other text, preambles, or explanations. Only the JSON object.
Strictly adhere to the following JSON format:
{"subject": "subject here", "body": "body of the email here"}

Context:\n${context}\n\nUser Request: ${userQuery}`;

    const geminiResponse = await queryModel.generateContent(prompt);
    const geminiText = geminiResponse.response.text();

    console.log("Raw Gemini Response (getEmail):", geminiText);

    let structured_json;
    try {
      const cleanedJsonText = geminiText.replace(/```json\n|\n```/g, "").trim();
      structured_json = JSON.parse(cleanedJsonText);
    } catch (jsonError) {
      console.error("❌ Failed to parse Gemini response as JSON (getEmail):", jsonError);
      console.error("Raw Gemini text that failed parsing:", geminiText);
      return res.status(500).json({
        success: false,
        error: "Failed to process AI response. Invalid JSON format from AI.",
        details: jsonError.message,
        ai_response_raw: geminiText,
      });
    }

    // console.log("Parsed Structured JSON (getEmail):", structured_json);
    res.json({ success: true, response: structured_json });
  } catch (error) {
    console.error("❌ Error handling /getEmail request:", error);
    res.status(500).json({ success: false, error: "Server error during email generation.", details: error.message });
  }
});

app.get("/gemini-test", (req, res) => {
  res.sendFile(path.join(__dirname, "gemini.html"));
});

app.post("/process-file", upload.single("file"), async (req, res) => {
  let filePath = null; // Declare filePath here to ensure it's accessible in finally block
  let tempFilePath = null; // Declare tempFilePath here

  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: "No file uploaded." });
    }

    filePath = req.file.path; // The path where Multer saved the file
    const filename = req.file.originalname;

    const extractedText = await extractTextFromPDF(filePath);
    const review = await reviewContract(extractedText);

    // After successfully extracting text, you might want to embed and upsert it to Pinecone here
    // Example:
    // await embedAndUpsertChunks({ text: extractedText, metadata: { source: filename, type: "contract_review" } });
    // This is the correct place to call embedAndUpsertChunks if this endpoint is for document ingestion.

    // Create a temporary file with the review content
    tempFilePath = path.join(uploadDir, `corrected_${Date.now()}_${filename}.json`); // Use a unique name for corrected file
    await fs.writeFile(tempFilePath, JSON.stringify(review, null, 2), "utf8");

    // Send the corrected file back to the user
    res.download(tempFilePath, `corrected_${filename}.json`, async (err) => {
      if (err) {
        console.error("❌ Error sending file:", err);
        // It's crucial to still try to clean up even if download fails
        if (filePath) await fs.unlink(filePath).catch(unlinkErr => console.error("Error unlinking original file after download error:", unlinkErr));
        if (tempFilePath) await fs.unlink(tempFilePath).catch(unlinkErr => console.error("Error unlinking temp file after download error:", unlinkErr));
      } else {
        // Clean up files after successful download
        if (filePath) await fs.unlink(filePath).catch(unlinkErr => console.error("Error unlinking original file:", unlinkErr));
        if (tempFilePath) await fs.unlink(tempFilePath).catch(unlinkErr => console.error("Error unlinking temp file:", unlinkErr));
      }
    });
  } catch (error) {
    console.error("❌ Error processing file:", error);
    // Ensure files are cleaned up even if other errors occur before download
    if (filePath) await fs.unlink(filePath).catch(unlinkErr => console.error("Error unlinking original file on process error:", unlinkErr));
    if (tempFilePath) await fs.unlink(tempFilePath).catch(unlinkErr => console.error("Error unlinking temp file on process error:", unlinkErr));
    res.status(500).json({ success: false, error: "Server error processing file", details: error.message });
  }
});

app.get("/chat", (req, res) => {
  res.sendFile(path.join(__dirname, "chat.html"));
});

app.post("/chat", async (req, res) => {
  const userMessage = req.body.text;

  try {
    if (!userMessage) {
      return res.status(400).json({ success: false, error: "Message is required." });
    }

    let conversationHistory = req.session.conversationHistory || [];
    conversationHistory.push({ role: "user", content: userMessage });

    // IMPORTANT: embedAndUpsertChunks should NOT be called here with the user query.
    // It's for ingesting documents into Pinecone, not for handling user queries.

    const embedResponse = await embedModel.embedContent({
      content: { parts: [{ text: userMessage }] }, // embed the user message for RAG
    });
    const queryEmbedding = embedResponse.embedding.values;

    let queryResult;
    try {
      const index = pinecone.index(process.env.PINECONE_INDEX_NAME);
      queryResult = await index.query({
        vector: queryEmbedding,
        topK: 5,
        includeMetadata: true,
      });
    } catch (pineconeError) {
      console.error("❌ Pinecone query error:", pineconeError);
      return res.status(500).json({
        success: false,
        error: "Error querying knowledge base for chat",
        details: pineconeError.message,
      });
    }

    let context = "";
    if (queryResult.matches && queryResult.matches.length > 0) {
      context = queryResult.matches
        .map((match) => match.metadata.text)
        .join("\n\n");
    }

    // console.log("Chat context for Gemini:", context); // For debugging

    let prompt = "You are a highly knowledgeable and professional AI legal assistant designed to help small businesses, freelancers, and startups navigate legal complexities. Respond concisely and professionally. Here is the conversation history:\n";
    conversationHistory.forEach((message) => {
      prompt += `${message.role}: ${message.content}\n`;
    });
    prompt += `\nBased on the provided context (if available, otherwise use general knowledge):\n${context}\n\nAnswer the user's last message: ${userMessage}.
    Your response MUST be a valid JSON object. Do not include any other text, preambles, or explanations. Only the JSON object.
    Strictly adhere to the following JSON format: {"response": "bot response here"}`;

    const geminiResponse = await queryModel.generateContent(prompt);
    const geminiText = geminiResponse.response.text();

    console.log("Raw Gemini Response (chat):", geminiText);

    let structured_json;
    try {
      const cleanedJsonText = geminiText.replace(/```json\n|\n```/g, "").trim();
      structured_json = JSON.parse(cleanedJsonText);
    } catch (jsonError) {
      console.error("❌ Failed to parse Gemini response as JSON (chat):", jsonError);
      console.error("Raw Gemini text that failed parsing:", geminiText);
      return res.status(500).json({
        success: false,
        error: "Failed to process AI response. Invalid JSON format from AI.",
        details: jsonError.message,
        ai_response_raw: geminiText,
      });
    }

    // Update conversation history with bot's parsed response
    conversationHistory.push({ role: "bot", content: structured_json.response });
    req.session.conversationHistory = conversationHistory;

    // console.log("Parsed Structured JSON (chat):", structured_json);
    res.json({ success: true, response: structured_json });
  } catch (error) {
    console.error("❌ Error handling chat message:", error);
    res.status(500).json({ success: false, error: "Server error during chat.", details: error.message });
  }
});

app.get("/chat/history", (req, res) => {
  try {
    const conversationHistory = req.session.conversationHistory || [];
    res.json({ success: true, history: conversationHistory });
  } catch (error) {
    console.error("❌ Error retrieving chat history:", error);
    res.status(500).json({ success: false, error: "Server error retrieving chat history." });
  }
});

// Start the server
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});