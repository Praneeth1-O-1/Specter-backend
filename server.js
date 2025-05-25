
const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const multer = require("multer");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { Pinecone } = require("@pinecone-database/pinecone");
const fs = require("fs");
const path = require("path");
const { extractTextFromPDF, reviewContract } = require("./fileupload");
const { embedAndUpsertChunks } = require("./embed");
const { pipeline } = require('@xenova/transformers'); 
const session = require('express-session');



require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 5000;

// Pinecone Initialization with proper configuration
const pinecone = new Pinecone({ 
  apiKey: process.env.PINECONE_API_KEY,
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false }  // Set to `true` if using HTTPS
}));


// MongoDB Connection
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log("✅ MongoDB Connected"))
    .catch((err) => console.error("❌ MongoDB Connection Error:", err));

// Multer Setup for PDF uploads
const storage = multer.diskStorage({
    destination: "uploads/",
    filename: (req, file, cb) => {
        cb(null, file.originalname);
    },
});

const upload = multer({ storage: storage });


app.post("/getVun", async (req, res) => {
    try {
        // console.log(req.body.text);
        await embedAndUpsertChunks({text:req.body.text,metadata:"IP Law"});
        const userQuery = "tell me the vunarabilities in the document";

        if (!userQuery) {
            return res.status(400).json({ success: false, error: "Query is required." });
        }

        const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
        const embedModel = genAI.getGenerativeModel({ model: "embedding-001" });

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
                includeValues: true,
            });
        } catch (pineconeError) {
            console.error("Pinecone query error:", pineconeError);
            return res.status(500).json({ 
                success: false, 
                error: "Error querying knowledge base",
                details: pineconeError.message 
            });
        }


        let context = "";
        if (queryResult.matches && queryResult.matches.length > 0) {
             
            context = queryResult.matches
                .map((match) => {
                    console.log(match.metadata);
                    return match.metadata.text
        })
        }


        console.log(context);
        const prompt = `Answer the following question based on the provided context:\n\nContext:\n${context}\n\nQuestion: ${userQuery} and the give the response is **strictly** in JSON format without extra text in the format of  {"document_name": "document name here","summary": "summary here","sections": [{"title": "title here","description": "description","vulnerabilities": [{"issue": "issue here","risk_level": "risklevel here","details": "details here"}]}`;
        const queryModel=genAI.getGenerativeModel({model:"gemini-2.0-flash"});
        const geminiResponse = await queryModel.generateContent(prompt);
        const geminiText = geminiResponse.response.text();

        console.log("Gemini Response:", geminiText);

        const cleanedJsonText = geminiText.replace(/```json\n|\n```/g, "");
        let structured_json = JSON.parse(cleanedJsonText);
        console.log(structured_json);
        res.json({ success: true, response: structured_json });

    } catch (error) {
        console.error("❌ Error handling text query:", error);
        res.status(500).json({ success: false, error: "Server error during text query." });
    }
});




app.post("/getEmail", async (req, res) => {
    try {
        // console.log(req.body.text);
        await embedAndUpsertChunks({text:req.body.text,metadata:"IP Law"});
        const userQuery = req.body.query;

        if (!userQuery) {
            return res.status(400).json({ success: false, error: "Query is required." });
        }

        const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
        const embedModel = genAI.getGenerativeModel({ model: "embedding-001" });

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
                includeValues: true,
            });
        } catch (pineconeError) {
            console.error("Pinecone query error:", pineconeError);
            return res.status(500).json({ 
                success: false, 
                error: "Error querying knowledge base",
                details: pineconeError.message 
            });
        }


        let context = "";
        if (queryResult.matches && queryResult.matches.length > 0) {
             
            context = queryResult.matches
                .map((match) => {
                    console.log(match.metadata);
                    return match.metadata.text
        })
        }

        console.log(context);
        const prompt = `Generate a email by the request of user based on the provided context:\n\nContext:\n${context}\n\nQuestion: ${userQuery} and the give the response is **strictly** in JSON format without extra text in the format of  {"subject":"subject here","body":"body of the email here"}]}`;
        const queryModel=genAI.getGenerativeModel({model:"gemini-2.0-flash"});
        const geminiResponse = await queryModel.generateContent(prompt);
        const geminiText = geminiResponse.response.text();

        console.log("Gemini Response:", geminiText);

        const cleanedJsonText = geminiText.replace(/```json\n|\n```/g, "");
        let structured_json = JSON.parse(cleanedJsonText);
        console.log(structured_json);
        res.json({ success: true, response: structured_json });

    } catch (error) {
        console.error("❌ Error handling text query:", error);
        res.status(500).json({ success: false, error: "Server error during text query." });
    }
});

app.get("/gemini-test", (req, res) => {
    res.sendFile(path.join(__dirname, "gemini.html"));
});

// 4. POST Route for Sending Corrected File (Process File)
app.post("/process-file", upload.single("file"), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, error: "No file uploaded." });
        }

        const filePath = req.file.path;
        const filename = req.file.originalname;

        const extractedText = await extractTextFromPDF(filePath);
        const review = await reviewContract(extractedText);
        
        // Create a temporary file with the review content
        const tempFilePath = path.join("uploads", `corrected_${filename}`);
        fs.writeFileSync(tempFilePath, JSON.stringify(review, null, 2), "utf8");

        // Send the corrected file back to the user
        res.download(tempFilePath, `corrected_${filename}`, (err) => {
            if (err) {
                console.error("Error sending file:", err);
            }
            // Clean up files
            fs.unlinkSync(filePath);
            fs.unlinkSync(tempFilePath);
        });

    } catch (error) {
        console.error("❌ Error processing file:", error);
        res.status(500).json({ success: false, error: "Server error processing file" });
    }
});


app.get('/chat', (req, res) => {
    res.sendFile(path.join(__dirname,'chat.html'));
});
app.post('/chat', async (req, res) => {
    try {
        const userMessage = req.body.text;
        if (!userMessage) {
            return res.status(400).json({ success: false, error: "Message is required." });
        }

        let conversationHistory = req.session.conversationHistory || [];
        conversationHistory.push({ role: 'user', content: userMessage });

        await embedAndUpsertChunks({ text: userMessage, metadata: "IP Law" });

        const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
        const embedModel = genAI.getGenerativeModel({ model: "embedding-001" });

        const embedResponse = await embedModel.embedContent({
            content: { parts: [{ text: userMessage }] }, // embed the user message
        });
        const queryEmbedding = embedResponse.embedding.values;

        let queryResult;
        try {
            const index = pinecone.index(process.env.PINECONE_INDEX_NAME);
            queryResult = await index.query({
                vector: queryEmbedding,
                topK: 5,
                includeMetadata: true,
                includeValues: true,
            });
        } catch (pineconeError) {
            console.error("Pinecone query error:", pineconeError);
            return res.status(500).json({
                success: false,
                error: "Error querying knowledge base",
                details: pineconeError.message,
            });
        }

        let context = "";
        if (queryResult.matches && queryResult.matches.length > 0) {
            context = queryResult.matches
                .map((match) => match.metadata.text)
                .join("\n");
        }

        let prompt = "You are a highly knowledgeable and professional AI legal assistant designed to help small businesses, freelancers, and startups navigate legal complexities. Here is he conversation history:\n";
        conversationHistory.forEach(message => {
            prompt +=`${message.role}: ${message.content}\n`;
        });
        prompt += `\nBased on the context:\n${context}\n\nAnswer the user's last message: ${userMessage}. Give the response in **strictlt** in JSON format without any extra text: {"response": "bot response here"}`;

        const queryModel = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
        const geminiResponse = await queryModel.generateContent(prompt);
        const geminiText = geminiResponse.response.text()
        conversationHistory.push({ role: 'bot', content: geminiText });
        req.session.conversationHistory = conversationHistory;


        const cleanedJsonText = geminiText.replace(/```json\n|\n```/g, "");
        let structured_json = JSON.parse(cleanedJsonText);
        console.log(geminiText);

        res.json({ success: true, response: structured_json });
    } catch (error) {
        console.error("❌ Error handling chat message:", error);
        res.status(500).json({ success: false, error: "Server error during chat." });
    }
});
app.get('/chat/history', (req, res) => {
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