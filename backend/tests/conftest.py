import os

# Set before the app is imported (config reads the environment once).
os.environ["MONGO_URL"] = "mongomock://"
os.environ["DEMO_MODE"] = "true"
os.environ["JWT_SECRET"] = "test-secret-that-is-long-enough-for-hs256"
os.environ["RAZORPAY_KEY_ID"] = ""
os.environ["RAZORPAY_KEY_SECRET"] = ""
os.environ["ADMIN_USERS"] = "ritissh, Kritheesh"
os.environ["ADMIN_PASSWORD"] = "test-admin-pw"

ADMIN_PASSWORD = "test-admin-pw"
