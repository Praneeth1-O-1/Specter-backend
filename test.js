
const nodemailer = require("nodemailer");
const axios = require("axios");
require("dotenv").config();

// Function to generate AI-powered Notice in JSON format
async function generateNotice(context) {
    const prompt = `Answer the following based on the provided context:\n\n
    Context:\n${context}\n\n
    Question: Generate a formal notice regarding the identified issue. The response **must** be in JSON format without extra text, in the following structure:\n
    {
      "document_name": "Document Name",
      "recipient": "Recipient Name",
      "subject": "Notice Regarding Identified Issue",
      "body": "Formal notice text including issue details, actions required, and deadline",
      "sections": [
        {
          "title": "Issue Identified",
          "description": "Brief description of the issue",
          "vulnerabilities": [
            {
              "issue": "Issue Found",
              "risk_level": "High/Medium/Low",
              "details": "Detailed explanation of the risk and necessary action"
            }
          ]
        }
      ]
    }`;

    try {
        const response = await axios.post("https://api.gemini.com/generate", {
            prompt: prompt,
            max_tokens: 500,
        });

        return response.data; // AI-generated JSON response
    } catch (error) {
        console.error("AI Notice Generation Error:", error);
        return null;
    }
}

// Function to send email
async function sendNoticeEmail(noticeJSON) {
    const transporter = nodemailer.createTransport({
        service: "Gmail",
        auth: {
            user: process.env.EMAIL_USER,  // Your email
            pass: process.env.EMAIL_PASS,  // App password or OAuth
        },
    });

    const mailOptions = {
        from: process.env.EMAIL_USER,
        to: noticeJSON.recipient,
        subject: noticeJSON.subject,
        text: noticeJSON.body,
    };

    try {
        let info = await transporter.sendMail(mailOptions);
        console.log("Email sent:", info.response);
        return { success: true, message: "Email sent successfully." };
    } catch (error) {
        console.error("Email Error:", error);
        return { success: false, message: "Failed to send email." };
    }
}

// API Endpoint to Get Vulnerabilities and Send Notice
async function getVulnAndSendNotice(contractData) {
    const vulnerabilities = extractVulnerabilities(contractData); // Your function to parse contract issues

    if (vulnerabilities.length === 0) {
        return { success: false, message: "No vulnerabilities found." };
    }

    const noticeContext = JSON.stringify({ document: contractData.name, vulnerabilities });

    const noticeJSON = await generateNotice(noticeContext);

    if (!noticeJSON) {
        return { success: false, message: "Failed to generate notice." };
    }

    return await sendNoticeEmail(noticeJSON);
}

module.exports = { getVulnAndSendNotice };
