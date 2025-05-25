const { GoogleGenerativeAI } = require("@google/generative-ai");
const { Pinecone } = require("@pinecone-database/pinecone");
const dotenv = require("dotenv");
const { v4: uuidv4 } = require('uuid');

dotenv.config();

const pinecone = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const index = pinecone.index(process.env.PINECONE_INDEX_NAME);

async function embedAndUpsertChunks(document) {
    try {
        const text = document.text;
        const metadata = document.metadata;

        // Automated Chunking Logic
        const chunks = chunkText(text); // Call the chunking function

        const texts = chunks.map(chunk => chunk.text);
        const chunkMetadata = chunks.map(chunk => ({ id: chunk.id, text: chunk.text, ...metadata }));

        // Generate embeddings using Gemini
        const model = genAI.getGenerativeModel({ model: "embedding-001" });
        const embeddings = await Promise.all(
            texts.map(async (text) => {
                const response = await model.embedContent({
                    content: {
                        parts: [{ text: text }],
                    },
                });
                return response.embedding.values;
            })
        );

        const vectors = embeddings.map((values, i) => ({
            id: chunkMetadata[i].id,
            values: values,
            metadata: chunkMetadata[i]
        }));

        // Upsert (store) into Pinecone
        await index.upsert(vectors);

        console.log("✅ Successfully inserted automated chunked embeddings into Pinecone!");
    } catch (error) {
        console.error("❌ Error inserting automated chunked embeddings:", error);
    }
}

// Function to automatically chunk text based on sections and sentences.
function chunkText(text) {
    const sectionRegex = /(\d+\.\s[^\n]+)/g; // Matches sections like "1. Introduction"
    const sentenceRegex = /(?<=[.!?])\s+(?=[A-Z])/; // Splits sentences

    const sections = text.split(sectionRegex).filter(Boolean); // Split into sections

    const chunks = [];
    for (let i = 0; i < sections.length; i++) {
        const section = sections[i].trim();
        if (section.match(/^\d+\./)) { // If it's a section header
            chunks.push({ text: section, id: uuidv4() });
        } else { // If it's section content
            const sentences = section.split(sentenceRegex).map(s => s.trim()).filter(Boolean);
            sentences.forEach(sentence => {
                chunks.push({ text: sentence, id: uuidv4() });
            });
        }
    }
    return chunks;
}

// Example: Call function with sample data
// embedAndUpsertChunks({
//     text: "Privacy PolicyEffective Date: March 27, 20251. IntroductionWelcome to [Company Name]. Your privacy is important to us. This Privacy Policy explains how we collect, use, and protect your personal data when you use our services.2. Information We CollectWe collect personal information such as your name, email address, phone number, and payment details when you use our services.3. How We Use Your InformationWe may use your personal data to:Provide and improve our servicesSend promotional emails and notificationsShare with our trusted partners for marketing purposes4. Data Storage and SecurityYour personal information is stored on our servers in plaintext format for easy access. We take reasonable steps to protect your data but cannot guarantee complete security against unauthorized access.5. Third-Party SharingWe may share your data with third parties, including advertisers and business partners, without obtaining explicit user consent, to enhance service offerings and marketing strategies.6. Your RightsYou have the right to request access, modification, or deletion of your data by contacting us.7. Changes to This PolicyWe may update this policy at any time without prior notice. Continued use of our services implies acceptance of any changes.8. Contact UsIf you have any questions about this policy, please contact us at privacy@[company].com.Note: This policy contains security vulnerabilities and should not be used as a real privacy policy.",
//     metadata: { category: "IP law" }
// });

module.exports = {embedAndUpsertChunks}