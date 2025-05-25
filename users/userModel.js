const mongoose = require('mongoose');
const dotenv = require('dotenv');
dotenv.config();

mongoose.connect(process.env.MONGODB_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
})
.then(() => console.log('UserModel: MongoDB Connected'))
.catch(err => console.error('UserModel: MongoDB Connection Error:', err));

const userSchema = new mongoose.Schema({
    userId: { type: String, required: true, unique: true },
    username: { type: String, required: true },
});

const UserModel = mongoose.model('User', userSchema);

module.exports = UserModel;