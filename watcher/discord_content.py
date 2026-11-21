"""The words the bot posts: welcome, rules, how-it-works, and the opt-in panel.

Kept apart from the mechanics so the owner can edit the text and re-run
``python -m watcher discord-server`` to update the posts in place.
"""
from __future__ import annotations

GOLD, BLUE = 0xFDB515, 0x003262   # California Gold, Berkeley Blue

# custom_id values of the panel's buttons; handled in watcher.discord_bot
BTN_BROWSE, BTN_MINE, BTN_REQUEST, BTN_ALL = "cc:browse", "cc:mine", "cc:request", "cc:all"


def _ch(channels: dict, key: str) -> str:
    return f"<#{channels[key]}>" if channels.get(key) else f"#{key.replace('_', '-')}"


def info_messages(guild_name: str, ch: dict) -> dict[str, dict]:
    """{channel key: message payload} for the read-only info channels."""
    footer = {"text": "Student-run. Not affiliated with or endorsed by UC Berkeley."}
    welcome = {
        "title": f"Welcome to {guild_name}",
        "color": BLUE,
        "description": (
            "This server watches the UC Berkeley class schedule and pings you the moment a seat, "
            "a reserved seat, or a waitlist spot opens in a class you care about.\n\n"
            "**Get started in three steps**\n"
            f"1. Read the {_ch(ch, 'rules')}.\n"
            f"2. Open {_ch(ch, 'get_alerts')} and pick your classes. Each class you pick unlocks its own "
            "alert channel and gives you a role that gets pinged.\n"
            f"3. Don't see your class? Press **Request a class** in {_ch(ch, 'get_alerts')} or use `/watch`.\n\n"
            "**Where things are**\n"
            f"{_ch(ch, 'how_it_works')} explains what each alert means.\n"
            f"{_ch(ch, 'feed')} shows every alert for every class, without pings.\n"
            f"{_ch(ch, 'enrollment_help')} is for enrollment questions, {_ch(ch, 'feedback')} for bugs and ideas.\n"
            f"{_ch(ch, 'announcements')} has news from the staff."
        ),
        "footer": footer,
    }
    rules = {
        "title": "Server rules",
        "color": GOLD,
        "description": (
            "**1. Be respectful.** No harassment, hate speech, or personal attacks.\n"
            "**2. No selling or trading seats.** Offering or asking for money for a seat, a swap, or a "
            "waitlist spot is against university policy and gets you banned here.\n"
            "**3. No academic dishonesty.** Don't share or ask for exams, graded work, or answers.\n"
            "**4. No spam or advertising.** That includes unsolicited DMs to members.\n"
            "**5. Keep it on topic** and in the right channel.\n"
            "**6. Protect privacy.** Don't post anyone's personal information, including your own "
            "student ID or CalNet details. Staff will never ask for your password.\n"
            "**7. Don't abuse the bot.** Request only classes you really plan to take.\n"
            "**8. Follow Discord's Terms of Service and Community Guidelines.**\n\n"
            "Moderators may remove content or members at their discretion. "
            f"Problems? Mention a Moderator or post in {_ch(ch, 'feedback')}."
        ),
        "footer": footer,
    }
    how = {
        "title": "How seat alerts work",
        "color": BLUE,
        "description": (
            "A watcher checks classes.berkeley.edu around the clock, every few minutes, for every class listed in "
            f"{_ch(ch, 'get_alerts')} and posts when something changes."
        ),
        "fields": [
            {"name": "Alerts that ping you", "value": (
                "🟢 **Seats open**: an unreserved seat appeared in a class that was full.\n"
                "🟢 **Reserved seats open**: a seat opened in a reserved group (for example, for a major). "
                "Check whether you qualify.\n"
                "🟡 **Waitlist open**: the waitlist has room, or a waitlist was just created.")},
            {"name": "Alerts without a ping", "value": "🔵 More seats were added to a class that already had some."},
            {"name": "Choosing classes", "value": (
                f"Use the buttons in {_ch(ch, 'get_alerts')}, or type `/watch`, `/unwatch` and `/alerts` anywhere. "
                "Picking a class gives you its role and shows its channel. Unpicking removes both.")},
            {"name": "Tips", "value": (
                "Seats can be gone within seconds, so keep CalCentral open and logged in during your enrollment window.\n"
                "Turn on notifications for mentions on your phone. The server default is mentions only, "
                "so you are not buzzed for classes you did not pick.\n"
                f"Want a ping for every class? Use **Every Alert** in {_ch(ch, 'get_alerts')}.")},
            {"name": "Limits", "value": (
                "Alerts depend on the public schedule, which can lag CalCentral by a few minutes, and on the "
                "watcher being online. An alert is a heads-up, not a guarantee of a seat. "
                "Always confirm in CalCentral.")},
        ],
        "footer": footer,
    }
    return {"welcome": {"embeds": [welcome]}, "rules": {"embeds": [rules]}, "how_it_works": {"embeds": [how]}}


def panel(courses: list[str], ch: dict) -> dict:
    """The persistent opt-in message in #get-alerts."""
    if courses:
        shown = ", ".join(f"`{c}`" for c in courses[:60]) + (" and more" if len(courses) > 60 else "")
        watching = f"**{len(courses)} class{'' if len(courses) == 1 else 'es'} watched right now**\n{shown}"
    else:
        watching = "No classes are being watched yet. Request the first one below."
    embed = {
        "title": "🔔 Get seat alerts",
        "color": GOLD,
        "description": (
            "Pick the classes you want to be pinged for. Each one gives you a role and unlocks that "
            "class's alert channel. Only you can see your choices here.\n\n"
            f"{watching}\n\n"
            "**Browse classes**: choose from the classes already being watched.\n"
            "**My alerts**: see or clear what you are signed up for.\n"
            "**Request a class**: add a class that is not listed yet. It is checked against the schedule and usually goes live right away.\n"
            "**Every Alert**: turn pings for every class on or off.\n\n"
            "Slash commands work too: `/watch`, `/unwatch`, `/alerts`, `/classes`."
        ),
    }
    button = lambda style, label, cid: {"type": 2, "style": style, "label": label, "custom_id": cid}  # noqa: E731
    return {"embeds": [embed], "components": [{"type": 1, "components": [
        button(1, "Browse classes", BTN_BROWSE), button(2, "My alerts", BTN_MINE),
        button(3, "Request a class", BTN_REQUEST), button(2, "Every Alert", BTN_ALL)]}]}
