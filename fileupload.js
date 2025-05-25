const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");
const axios = require("axios");
const mammoth = require("mammoth");
const { embedText } = require("./embed");
const pinecone = require("@pinecone-database/pinecone");

dotenv.config();

const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${process.env.GEMINI_API_KEY}`;


async function extractTextFromPDF(pdfPath) {
    try {
        const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");

        if (!fs.existsSync(pdfPath)) {
            return { success: false, error: `File not found: ${pdfPath}` };
        }

        const dataBuffer = new Uint8Array(fs.readFileSync(pdfPath));
        const pdf = await getDocument({ data: dataBuffer }).promise;

        let text = "";
        for (let i = 1; i <= pdf.numPages; i++) {
            const page = await pdf.getPage(i);
            const content = await page.getTextContent();
            text += content.items.map((item) => item.str).join(" ") + "\n";
        }

        return { success: true, text: text };
    } catch (error) {
        console.error("Error extracting text from PDF:", error);
        return { success: false, error: `Error extracting text from PDF: ${error.message}` };
    }
}


async function extractTextFromDOCX(docxPath) {
    try {
        if (!fs.existsSync(docxPath)) {
            return { success: false, error: `File not found: ${docxPath}` };
        }
        const result = await mammoth.extractRawText({ path: docxPath });
        return { success: true, text: result.value };
    } catch (error) {
        console.error("Error extracting text from DOCX:", error);
        return { success: false, error: `Error extracting text from DOCX: ${error.message}` };
    }
}

async function extractTextFromTXT(txtPath) {
    try {
        if (!fs.existsSync(txtPath)) {
            return { success: false, error: `File not found: ${txtPath}` };
        }
        const text = fs.readFileSync(txtPath, 'utf-8');
        return { success: true, text: text };
    } catch (error) {
        console.error("Error extracting text from TXT:", error);
        return { success: false, error: `Error extracting text from TXT: ${error.message}` };
    }
}

async function extractTextFromFile(filePath) {
    const fileExtension = path.extname(filePath).toLowerCase();

    if (fileExtension === ".pdf") {
        return extractTextFromPDF(filePath);
    } else if (fileExtension === ".docx") {
        return extractTextFromDOCX(filePath);
    } else if (fileExtension === ".txt") {
        return extractTextFromTXT(filePath);
    } else {
        return { success: false, error: `Unsupported file type: ${fileExtension}` };
    }
}

async function reviewContract(text) {
    try {
        const response = await axios.post(GEMINI_API_URL, {
            contents: [{ parts: [{ text: `Review this contract for legal risks and flaws, and produce a list of potential issues:\n\n${text}` }] }]
        }, {
            headers: { "Content-Type": "application/json" }
        });

        return { success: true, result: response.data.candidates[0].content.parts[0].text };
    } catch (error) {
        console.error("Error querying Gemini API:", error.response?.data || error.message);
        return { success: false, error: `An error occurred while processing your request: ${error.message}` };
    }
}

async function processFileAndReview(filePath, fileName) {
    const extractionResult = await extractTextFromFile(filePath);

    if (!extractionResult.success) {
        return extractionResult;
    }

    const text = extractionResult.text;
    const cleanedText = text.replace(/\s+/g, ' ').trim();

    const embedding = await embedText(cleanedText);

    if (!embedding.success) {
        return embedding;
    }

    try {
        const index = pineconeClient.Index(process.env.PINECONE_INDEX);
        await index.upsert([
            {
                id: fileName,
                values: embedding.embedding,
                metadata: { text: cleanedText },
            },
        ]);
    } catch (error) {
        console.error("Error storing embedding in Pinecone:", error);
        return { success: false, error: "Error storing embedding in Pinecone" };
    }

    return reviewContract(cleanedText);
}

async function queryPineconeAndGemini(query) {
    try {
        const queryEmbedding = await embedText(query);
        if (!queryEmbedding.success) {
            return { success: false, error: "Embedding failed" };
        }

        const index = pineconeClient.Index(process.env.PINECONE_INDEX);
        const searchResult = await index.query({
            vector: queryEmbedding.embedding,
            topK: 3,
            includeMetadata: true,
        });

        if (searchResult.matches && searchResult.matches.length > 0) {
            const retrievedTexts = searchResult.matches.map((match) => match.metadata.text);
            const context = retrievedTexts.join("\n\n");
            const geminiPrompt = `Answer the question based on the provided context:\n\nContext:\n${context}\n\nQuestion: ${query}`;

            const geminiResponse = await axios.post(GEMINI_API_URL, {
                contents: [{ parts: [{ text: geminiPrompt }] }],
            }, { headers: { "Content-Type": "application/json" } });

            return { success: true, result: geminiResponse.data.candidates[0].content.parts[0].text };
        } else {
            return { success: true, result: "No relevant results found." };
        }
    } catch (error) {
        console.log("Error in queryPineconeAndGemini:", error);
        return { success: false, error: "An error occurred during the query." };
    }
}

module.exports = { processFileAndReview, queryPineconeAndGemini,extractTextFromPDF, reviewContract };