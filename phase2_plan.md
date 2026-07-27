- assumptions:
chrome, windows, laptop only

extend the current app by adding one more feature.
build an extension. 
if i press "apply" button for a generation, (in either application logs page or individual application page), it opens the url that i gave, 
- if its linkedin url, dont send, just disable the button at all

it opens the url in chrome, and the user manually moves to the page where we see the form details, and once user thinks this is the right place where we should enter details, he presses "fill" button which would show as part of Enpply extension, and it notifies the user using chrome/desktop notification, if i press it, I go to that tab, and confirm all the fields, and he will manually press the submit button.

- questions
For some known sites, can we benefit?
Review and let me know your thoughts.





The gap the plan doesn't address: how does the extension get the data?
- 1. Extension calls your api. but not only fetching existing data, but for any subsequent calls, it should call the enpply api. wait, should the api call be instead part of the extension and embedded into it?

File inputs cannot be set programmatically. For security, an extension can't assign input[type=file].value. So the résumé/CV PDF upload stays manual, always — no way around it. Your plan keeps submit manual, but you should explicitly carve out uploads too, or users will expect the PDF to attach itself.
- hmm most of the application apps like zippia and simplify or jobright fill in the file forms includign resume and cv themselves. how do they do that?

The notification step feels redundant
- enpply extension will first extract all the fields and determines whether it needs to call extra enpply/its internal api for answers (either using AI or any existing data)
so, its definitely async

- "For some known sites, can we benefit?"
Ok, actually i will use this only for the hard sites that simplify dont help.
The user will determine whether to use simplify or enpplify
lets call extension enpplify to avoid confusion with enpply which is currently only for generating docs

- Hmm, I think i have a significant problem
The main purpose why I am not making this as a standalone extension and instead connecting with Enpply is because I wanted to reuse the info generated during geneartion in enpply which also maps to each job id cuz it's identified by job link + profile. But how it would communicate with enpply either whether if the page is originated by a button click in enpply tab or just manually opened, how to communicate with enpply is a question. 
And what about this? making enpply as part of this extension, what that means is, if i press the button in the modal from extension, it runs generation on its side for not only resume. But there are many cases where jd and application page is seperated and even application page is divided into several steps/pages.
Please understand my design concerns and let me know your thoughts and recommendations. You are free to do web search.

one of my suggestion is, we ask the user to press button or choice or even some text inputs at each step/page of application. e.g. he presses button "add this page as context", and in the process of this application either app or user determins whether to start generation (or in some cases intentionally or unintensionally there should be several generation runs either for answers to questions or resumes...) and the UI should always be editable by user manually.
Dont be restricted to my suggestion...




- so the actual user experience is like this

1. if its linkedin or something where we only get only jd text not the url
Use current Enpply dashboard, nothing needed to be added at all
2. if User gets the job link, and opens it from a browser (either by pasting in the chrome page part, or pressing a button from another page)
In this case, the key thing is, his application process is definitely restricted to this chrome tab tho he can redirect to another page automatically (by pressing "apply" button) or change tabs (description/apply)

We should seperate generate docs from generate answers. Docs(resume and cv) are only depending on jd (assuming we store profile in the background in extension signin session). So resume generation can mostly be done in the first page. But as we are not sure, we should show "Generate", "Generate and fill", "Fill" "Fill only resume" (for pages where we would use simplify for entering other values without going to the length of using enpplify). buttons always. And generate button should a. dissapere once generation is done. or b. be replaced by "regenerage" which correesponds to rerun funcationality in enpply with resume and cv marked.
Fill means "generate answers" internally. For resumes it can simply attach the doc generated, for fields like name.... it should fetch from backend which would either use AI or stored data. (but as the labels or ids of each field in the web might differ case from case, how can we search against the data is also another question. So bascially using AI to do that must be the best solution while keeping the uuid of each field teach me how current auto bid apps identify each field ) 

Ok all in all, i am still an end user, so might have confusion or wrong understanding about concepts or bad ideas.
All what i can give you very clearly (ofc with some design options which are not currently unexplited/not thought of... or already clear)
User flow
- paste jd and link to enpply app, get the resume and send it somewhere else: do nothing
- visit the page, start generation of docs using enpplify (=extension), 
    a. and use simplify as it was available. in this case resume upload can be done either enpplify or manually
    b. simplify is not avilalabe there. So he relies on manual entering (either using google chrome autofill and manual entering): resume upload or not
    c. simplify is not avilalabe there. So he relies on enpplify basically: resume upload, fetch fields and options (not necessailiry in one shot), and fill them itself, and he reviews and submit.


now i gave you all the info. please let me know if you need any clarifications. once all the questions are clarified then we can start generating code!



now update the 
- copy button on leftmost side of each row in application page 
- button to extract the results to csv (should be able to select profile, date range, ...) 
- in the toast, seperate running and completed which are currently merged. and add dismiss button to each grop -> failed, running, and completed