# Multi-user — the questions to answer before any code

**How to use this:** write your answers straight into this file (under each
question is fine), then open a **fresh session** and say "read
`design/multi-user-questions.md`". That's the design session's starting point.

**⭐ = load-bearing.** These change the architecture, so they're the ones worth
the most thinking time. The rest can be decided later without rework.

**Don't feel obliged to answer all of them.** "I don't know yet" is a real answer —
it tells me to design something that keeps both options open.

---

## A. The shape of it

1. ⭐ Is a shared record **co-owned by everyone in it**, or still **yours**, with others invited in as visitors?

mine. three levels of priority. record owner, record member, guest. record owner highest control. record member edit everything almost everything except changing owner priority, maybe not settle a record(still able to view summary, just cant settle, delete etc. (more detail later). owner, member see all. guest only see and edit something (like which split they are part of) in the expenses they are in.



2. ⭐ Can an invited person **add their own expenses**, or only look?

as member yes, guest only edit the expense they are in, like add more move people/edit splits (or maybe cannot doing anything, bot sure have to manage convinient and security)



3. Is sharing **per-record**, or do you add someone as a "friend" once and then share many records with them?

i dont understand the question. what is sharing per-record mean. one thing, adding friends should be like in other social media add friend function. you can choose to add them to your people(friend) list or not.



## B. Getting in

4. How does someone join — a **link**, an **email invite**, or a **code** you read out?

by clicking the link? i dont understand the question should it be self-explanatory? receive link -> click link -> enter the record as guest.


5. Does the link let **anyone** in, or do you **approve** each person before they're in?


owner, member approve.



6. Can people you invited **invite others**?

yes. need approve anyways


7. Does a joiner need to **create an account**, or can they participate without one?

they can choose. without account views only.

## C. Identity

8. ⭐ Rui joins, and you already have a "Rui" placeholder. Who decides they're the same person — **you**, **Rui**, or **automatically by name**?

both. the owner / member or Rui herself can claim the token. 
flow: Rui join as guest through link. see her token, she can claim. wait for owner or member to approve. reversable if mistakes. if reverse rui separate from token. token hold everything the same.


9. What if Rui joins and you never made a placeholder for him — does he just appear as a new person?

yes. as a guest. everyone join the record as a guest. token stay there to be claim or as place holder.


10. Two of you both have a placeholder for Ana, who hasn't joined. Does that matter, or do you ignore it until she does?

can ignore at first until some one correct it.
token can also be merge. after merge all the split may change. if there were 4 Anas and later they merge into one the split porpotion will change (ex.from 10 to 7people)


11. Can someone **leave** a record? What happens to expenses they added?

oh, good question. im thinking:
1. leaves but token exist in place of him.(east leaves hard to clear expense if hes not in in thr furst place)
2. need approve from owner or couple of members. then he leaves all the expense cleanly. (hard get out, easy clear his name is mistakenly invited)


## D. What people see

12. ⭐ Does a member see **every expense** in the record, or **only the ones they're in**?

owner/member see all. guests only see the one they are in.


13. Do they see **everyone's balances**, or **only their own**?

same. owner/member see every balances. guest only see their owns.


14. Do they see the **settle plan / summary** for the whole record?

owner/member see all. for guest im not sure. i think they should only see who they have to pay, but maybe for transparency they should see all, but they can see from what they have to pay either way.


15. Guests (the person who came to one dinner) — can they be invited too, or do they stay placeholders?

they can, enter as guests.


16. Should a member be able to see your **other** records, or your people list? (I assume no — confirm.)


no, only the record they are in. Else it would be pretty messy and weird?


## E. Who can do what

17. ⭐ Who can **edit or delete** an expense that someone else added?

Everyone in the expense should be able to edit, but it should be some kind of verification, vote or show history log of what change. That's for the future unit, that I was talking about having history log, note, or comment section. Maybe when a person in the expense want to do something it will ask for permission or just show in there.

18. ⭐ Who can **freeze a summary**? It moves everyone's money at once and locks the expenses.

The owner/ creator of the expense.

19. Who can **rename / archive / delete** the whole record?

Owner. With approval from members.


20. Who can **remove a member**?

Owner/other members. Vote system? I don't know. or no vote just show in history log.

21. If two people edit the same expense at once, is "last one wins" acceptable?

im thinking of three options

1 acceptable if they edit the same thing. if they edit different things. keep both. maybe look at how people use git. im not a programmer but have heard of git.

2 last one wins but every edit shows in history log

3 when someone is editing, other cant edit


## F. Money

22. ⭐ A record has one currency era. If you and Rui have different home currencies, **whose** sets the record's?

the record creator


23. If someone disagrees with an expense, is **editing it** enough — or do you want a comment / dispute trail?

i think comment/dispute trail would be better as the one changing it could leave something to explain not a silently change the number


24. Should a member be able to **mark a transfer paid**, or only the person owed?

the person owed but other can send request



## G. Your existing data

25. ⭐ Should your **current records** become shareable, or does multi-user only apply to new ones?

can only apply to new ones. my old trip are likely finish. the multi user can be like a new version. (but dont clear old data just yet, still need the old data)


26. Your existing placeholders (Rui, Ana, Sofia…) — should those people be able to **claim** them when they join?

old data are likely for testing. we can keep old ones as it is. dont have to think about it too much.

## H. Scope — what's explicitly NOT in this phase

-i dont really understand the question...

Say yes/no; I'll assume "not now" unless you say otherwise.

27. Notifications ("Rui added an expense")?

need


28. Someone seeing a **combined balance** with you across several shared records?

 not now. keep note, talk about it later.

29. Offline support — still unsupported, still fine?

offline support would be nice too. i cannot use this app on the plane.

---

## What I already believe (push back if you disagree)

These are my working assumptions, so you only need to react to them:

- Balances stay **derived**, never stored — everything in Papaya derives, and a
  stored balance is a cache that can go stale.
-> i dont fully understand this

- A guest (no membership row) sees **their expense, not the record** — that's the
  model already built in §11.2 and it carries into multi-user unchanged.
- The **record's era is fixed at creation** and never re-denominates, exactly as
  it works today.
- Nothing about the money core changes. This phase is access and identity.
