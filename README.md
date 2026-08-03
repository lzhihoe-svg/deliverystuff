# 🏭 Kilang App

One simple web app that replaces your 3 WhatsApp groups:

| WhatsApp Group | App Tab | What happens |
|---|---|---|
| **Kilang Want** | 🧵 **Jahit** | Boss posts jobsheet photo → Amin **swipes right ❤️** (got it, sewing) or **swipes left ❌** (haven't seen it) — like Tinder |
| **Kilang Packing** | 🚚 **Hantar** | Boss posts jobsheet + instruction under **🛵 Lalamove / 🚌 Bus / 🤝 Pickup**. Staff must **take a photo of the parcel** to mark it done ✅ |
| **Kilang Postage** | 📦 **Pos** | Boss posts **airway bill + jobsheet** photos side by side. Staff sticks the right sticker, then **takes a photo of the parcel** to confirm ✅ |

Runs on **Google Apps Script** — free, no server, no monthly fee. Data is saved in a
Google Sheet (your audit log) and photos in a Google Drive folder, both created
automatically in your Google account.

---

## 🚀 How to set it up (10 minutes, one time only)

You need a Google account (e.g. your Gmail). Do this on a computer.

1. Go to **[script.google.com](https://script.google.com)** and click **➕ New project**.
2. You'll see a file called `Code.gs`. Delete everything inside it, then **copy-paste
   the whole content of `Code.gs` from this repository**.
3. Click the **➕ next to "Files"** → choose **HTML** → name it exactly **`Index`**
   (capital I, no `.html`). Delete everything inside, then **copy-paste the whole
   content of `Index.html` from this repository**.
4. Click the 💾 save icon. Name the project **Kilang App**.
5. Click **Deploy → New deployment**.
   - Click the ⚙️ gear → choose **Web app**.
   - **Execute as:** `Me`
   - **Who has access:** `Anyone` *(this is what lets your workers open it without a Google login)*
   - Click **Deploy**.
6. Google will ask for permission — click **Authorize access**, choose your account,
   click **Advanced → Go to Kilang App (unsafe)** → **Allow**.
   *(It says "unsafe" only because you wrote the app yourself — it's your own code.)*
7. Copy the **Web app URL** (ends in `/exec`). **That's your app.** 🎉

### 📱 Give it to your team

Send the URL once in WhatsApp, then have everyone **add it to their home screen**
so it looks like a real app:

- **Android (Chrome):** open the link → tap **⋮** → **Add to Home screen**
- **iPhone (Safari):** open the link → tap **Share** → **Add to Home Screen**

First time they open it, the app asks one thing only: **👷 Staff or 👔 Admin**.

- **👷 Staff** (default — just tap it): can post jobs, swipe jobsheets, and take
  proof photos. Cannot edit or delete anything.
- **👔 Admin** (needs the PIN): everything staff can do, plus **✏️ Edit**,
  **🗑️ Delete**, and **🗄️ Hide** buttons on every card. Switch role anytime
  with the button at the top right.

⚠️ **Change the Admin PIN before you deploy!** Open `Code.gs`, find
`var ADMIN_PIN = '1234';` near the top, and change it to your own secret number.
The PIN is checked on the server too, so staff cannot bypass it.

No names to type, no logins. The app also works nicely on a **computer** —
cards show in a grid, and all forms open centered on screen — so your office
staff can post jobs from their desk.

**Photos work on every device**: images are delivered through the app itself,
not through Google Drive share-links (which company Google accounts often
block). Nobody needs a Google login to see the pictures.

---

## 👀 Where your data lives

After the first use, look in your Google Drive:

- **`Kilang App Data`** (Google Sheet) — every job, who confirmed it, and exact
  timestamps. This is your permanent audit log — you can filter it, count jobs
  per day, and see who is fast and who is slow.
- **`Kilang App Photos`** (Drive folder) — every jobsheet, airway bill, and proof photo.

---

## 🔄 Updating the app later

If you change the code: paste the new code in script.google.com, then
**Deploy → Manage deployments → ✏️ Edit → Version: New version → Deploy**.
The URL stays the same — nobody needs a new link.

---

# 👔 CEO Notes — how this improves your factory flow

The app isn't just "WhatsApp with tabs". It fixes the real problems:

**1. Nothing gets lost in chat scroll.**
In WhatsApp, an unanswered jobsheet disappears upward. In the app, a job stays
in **⏳ Belum Siap** until someone physically acts on it. The red badge on each
tab shows exactly how many jobs are waiting — for everyone to see.

**2. Proof of work is forced, not requested.**
Staff *cannot* mark a delivery or postage job as done without taking a parcel
photo — the camera opens as part of the "done" button. No photo, no ✅. This
ends the "sudah hantar ke belum?" conversations.

**3. One glance = full factory status.**
- ❤️ = Amin is sewing it. ❌ = Amin hasn't seen it → follow up now.
- **⚠️ Lebih 1 hari!** appears automatically on any job pending more than 24
  hours — your late-delivery early warning, with zero effort.

**4. Works for everyone, educated or not.**
No reading required to operate it: photos first, big colored buttons, emoji.
Swipe right good, swipe left bad — everyone understands Tinder mechanics.
If a worker can use WhatsApp, they can use this. And because staff have no
edit/delete buttons, nothing can be removed by accident on the factory floor.

**5. You get free management data.**
The Google Sheet quietly records every job with exact timestamps for when it was
posted and when it was completed. After a month you can answer: How many jobs per
week? Average time from post → sewing → delivered? Which delivery method is
slowest? That's how you find your bottleneck.

### Suggested daily routine (SOP)

| Time | Who | Action |
|---|---|---|
| Morning | Boss | Post the day's jobsheets in 🧵 Jahit |
| Within 1 hour | Amin | Swipe every card — zero cards left in the stack |
| Midday | Boss | Check ❌ items and follow up; post 🚚 Hantar and 📦 Pos jobs |
| Before closing | Staff | Every parcel out the door = proof photo taken |
| Before closing | Boss | Badges should be zero; archive done jobs; anything ⚠️ red gets a phone call |

**Golden rule to announce to the team:** *"If it's not in the app with a photo, it didn't happen."*
