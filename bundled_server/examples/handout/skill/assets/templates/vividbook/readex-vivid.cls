\NeedsTeXFormat{LaTeX2e}
\ProvidesClass{readex-vivid}[2026/08/21 v1.2.9 Readex colorful study material class]

\LoadClass[UTF8,fontset=fandol,oneside,openany,11pt]{ctexbook}

\RequirePackage[a4paper,top=22mm,bottom=24mm,left=24mm,right=24mm,headheight=16pt]{geometry}
\RequirePackage{xcolor}
\RequirePackage{graphicx}
\RequirePackage{booktabs}
\RequirePackage{tabularx}
\RequirePackage{longtable}
\RequirePackage{array}
\RequirePackage{amsmath,amssymb,mathtools}
\RequirePackage{listings}
\RequirePackage[most]{tcolorbox}
\RequirePackage{tikz}
\RequirePackage{fancyhdr}
\RequirePackage{titlesec}
\RequirePackage{enumitem}
\RequirePackage{caption}
\RequirePackage{subcaption}
\RequirePackage{float}
\RequirePackage{microtype}
\RequirePackage{lastpage}
\RequirePackage{hyperref}
\RequirePackage{bookmark}

\definecolor{ReadexInk}{HTML}{25324A}
\definecolor{ReadexBlue}{HTML}{4A78E8}
\definecolor{ReadexCyan}{HTML}{3DB8C4}
\definecolor{ReadexPink}{HTML}{EC6F9E}
\definecolor{ReadexYellow}{HTML}{F3C969}
\definecolor{ReadexGreen}{HTML}{55B88A}
\definecolor{ReadexRed}{HTML}{D95763}
\definecolor{ReadexPaper}{HTML}{F8FAFD}
\definecolor{ReadexMuted}{HTML}{64748B}
\definecolor{ReadexLine}{HTML}{D7DEEA}

\color{ReadexInk}
\pagecolor{white}
\setlength{\parindent}{2em}
\setlength{\parskip}{0.35em}
\linespread{1.18}
\setlist{itemsep=0.25em,topsep=0.4em,leftmargin=2em}

\hypersetup{
  colorlinks=true,
  linkcolor=ReadexBlue,
  citecolor=ReadexGreen,
  urlcolor=ReadexPink,
  pdfborder={0 0 0}
}

\pagestyle{fancy}
\fancyhf{}
\fancyhead[L]{\small\color{ReadexMuted}\leftmark}
\fancyhead[R]{\small\color{ReadexMuted}\readexshorttitle}
\fancyfoot[C]{\small\color{ReadexMuted}\thepage\ / \pageref*{LastPage}}
\renewcommand{\headrulewidth}{0pt}

\titleformat{\chapter}[display]
  {\normalfont\bfseries\color{ReadexInk}}
  {\tikz[baseline=(n.base)]\node[fill=ReadexPink,text=white,rounded corners=3pt,inner xsep=8pt,inner ysep=3pt] (n) {CHAPTER \thechapter};}
  {0.8em}{\Huge}
  [\vspace{0.4em}{\color{ReadexPink}\rule{\textwidth}{1.4pt}}]
\titlespacing*{\chapter}{0pt}{-14pt}{24pt}

\titleformat{\section}
  {\Large\bfseries\color{ReadexBlue}}
  {\thesection}{0.7em}{}
  [\vspace{-0.35em}{\color{ReadexLine}\rule{\textwidth}{0.7pt}}]
\titleformat{\subsection}
  {\large\bfseries\color{ReadexInk}}
  {\thesubsection}{0.7em}{}

\newtcolorbox{importantbox}[1][核心结论]{
  enhanced,breakable,colback=ReadexPink!7,colframe=ReadexPink,
  boxrule=0.9pt,arc=2mm,left=3mm,right=3mm,top=2.5mm,bottom=2.5mm,
  title={#1},fonttitle=\bfseries,coltitle=white,attach boxed title to top left={xshift=3mm,yshift=-2mm},
  boxed title style={colback=ReadexPink,colframe=ReadexPink,arc=1.5mm}
}
\newtcolorbox{knowledgebox}[1][背景与直觉]{
  enhanced,breakable,colback=ReadexBlue!6,colframe=ReadexBlue,
  boxrule=0.9pt,arc=2mm,left=3mm,right=3mm,top=2.5mm,bottom=2.5mm,
  title={#1},fonttitle=\bfseries,coltitle=white,attach boxed title to top left={xshift=3mm,yshift=-2mm},
  boxed title style={colback=ReadexBlue,colframe=ReadexBlue,arc=1.5mm}
}
\newtcolorbox{warningbox}[1][易错点]{
  enhanced,breakable,colback=ReadexYellow!13,colframe=ReadexYellow!80!black,
  boxrule=0.9pt,arc=2mm,left=3mm,right=3mm,top=2.5mm,bottom=2.5mm,
  title={#1},fonttitle=\bfseries,coltitle=ReadexInk,attach boxed title to top left={xshift=3mm,yshift=-2mm},
  boxed title style={colback=ReadexYellow,colframe=ReadexYellow!80!black,arc=1.5mm}
}
\newtcolorbox{examplebox}[1][例子]{
  enhanced,breakable,colback=ReadexGreen!7,colframe=ReadexGreen,
  boxrule=0.9pt,arc=2mm,left=3mm,right=3mm,top=2.5mm,bottom=2.5mm,
  title={#1},fonttitle=\bfseries,coltitle=white,attach boxed title to top left={xshift=3mm,yshift=-2mm},
  boxed title style={colback=ReadexGreen,colframe=ReadexGreen,arc=1.5mm}
}

\lstdefinestyle{readex}{
  basicstyle=\ttfamily\small,
  keywordstyle=\bfseries\color{ReadexBlue},
  commentstyle=\itshape\color{ReadexGreen!70!black},
  stringstyle=\color{ReadexPink!85!black},
  backgroundcolor=\color{ReadexPaper},
  frame=single,rulecolor=\color{ReadexLine},
  numbers=left,numberstyle=\tiny\color{ReadexMuted},
  numbersep=8pt,breaklines=true,showstringspaces=false,
  tabsize=2,columns=fullflexible,keepspaces=true,
  xleftmargin=1.7em,framexleftmargin=1.4em,
  aboveskip=0.9em,belowskip=0.9em
}
\lstset{style=readex}

\captionsetup{font=small,labelfont={bf,color=ReadexBlue},textfont={color=ReadexInk}}

\newcommand{\readextitle}{学习讲义}
\newcommand{\readexshorttitle}{学习讲义}
\newcommand{\readexsubtitle}{}
\newcommand{\readexauthor}{Readex}
\newcommand{\readexdate}{\today}
\newcommand{\readexcoverimage}{}
\newcommand{\readexlinkswitch}{true}
\newif\ifreadexlinks
\readexlinkstrue
% A portable build is an App-owned policy, not a document preference. Lock the
% true branch to false so a later \readexlinkstrue in main.tex cannot override
% --no-readex-links. Links-enabled builds retain the ordinary mutable switch.
\newcommand{\readexforceportablelinks}{%
  \global\let\ifreadexlinks\iffalse
  \global\let\readexlinkstrue\readexlinksfalse
}
\newcommand{\readexprojectidentity}{}
\newcommand{\readexsetprojectidentity}[1]{\renewcommand{\readexprojectidentity}{#1}}
\InputIfFileExists{readex-project-context.tex}{}{}

\newcommand{\readexsource}[2]{%
  \ifreadexlinks
    \href{#1}{\textcolor{ReadexPink}{#2}}%
  \else
    {\textcolor{ReadexMuted}{#2}}%
  \fi
}
% Authors cite ordinary workspace paths. ReadOS injects only the current
% project's stable identity before compilation; source UUIDs never belong in
% model-authored TeX and the resulting PDF is never rewritten after compile.
% Hyperref writes URI bytes directly into XeLaTeX PDFs. Percent-encode the
% ordinary Unicode path first so PDFKit and URLComponents recover Chinese,
% spaces, and other UTF-8 path characters without mojibake or double encoding.
\ExplSyntaxOn
\str_new:N \l__readex_encoded_path_str
\tl_new:N \l__readex_source_url_tl
\cs_new_protected:Npn \readex_generated_uri_source:nn #1#2
  {
    \ifreadexlinks
      \use:c { hyper@linkurl }
        { \textcolor{ReadexPink}{#2} }
        {#1}
    \else
      {\textcolor{ReadexMuted}{#2}}
    \fi
  }
\cs_generate_variant:Nn \readex_generated_uri_source:nn { Vn }
\cs_new_protected:Npn \readex_path_source:nnn #1#2#3
  {
    \str_set_convert:Nnnn \l__readex_encoded_path_str {#1} {} {utf8/url}
    \tl_set:Nx \l__readex_source_url_tl
      {
        readex://content?
        \str_if_eq:eeF { \str_head:n {#1} } {/}
          {
            \tl_if_blank:eF { \readexprojectidentity }
              { project_id=\readexprojectidentity \c_ampersand_str }
          }
        path=\str_use:N \l__readex_encoded_path_str
        \tl_if_blank:nF {#2} { \c_ampersand_str #2 }
      }
    % The generated target is known to be a URI. Calling hyperref's URI action
    % directly avoids its filename/scheme guessing turning custom links into
    % remote-PDF (GoToR) actions.
    \readex_generated_uri_source:Vn \l__readex_source_url_tl {#3}
  }
% Compatibility for existing projects that already contain stable ReadOS
% workspace/content identities. New authoring continues to use ordinary paths.
\cs_new_protected:Npn \readex_identity_source:nnnn #1#2#3#4
  {
    \tl_set:Nx \l__readex_source_url_tl
      {
        readex://content?workspace_id=#1
        \c_ampersand_str content_id=#2
        \tl_if_blank:nF {#3} { \c_ampersand_str #3 }
      }
    \readex_generated_uri_source:Vn \l__readex_source_url_tl {#4}
  }
\NewDocumentCommand{\readexpdfsource}{m m m g}
  {
    \IfNoValueTF{#4}
      { \readex_path_source:nnn {#1} {page_number=#2} {#3} }
      { \readex_identity_source:nnnn {#1} {#2} {page_number=#3} {#4} }
  }
\NewDocumentCommand{\readexvideosource}{m m m g}
  {
    \IfNoValueTF{#4}
      { \readex_path_source:nnn {#1} {start=#2} {#3} }
      { \readex_identity_source:nnnn {#1} {#2} {start=#3} {#4} }
  }
\NewDocumentCommand{\readexvideosourcerange}{m m m m g}
  {
    \IfNoValueTF{#5}
      { \readex_path_source:nnn {#1} {start=#2\c_ampersand_str end=#3} {#4} }
      { \readex_identity_source:nnnn {#1} {#2} {start=#3\c_ampersand_str end=#4} {#5} }
  }
\NewDocumentCommand{\readextextsource}{m m m g}
  {
    \IfNoValueTF{#4}
      { \readex_path_source:nnn {#1} {line_number=#2} {#3} }
      { \readex_identity_source:nnnn {#1} {#2} {line_number=#3} {#4} }
  }
\NewDocumentCommand{\readextextsourcerange}{m m m m g}
  {
    \IfNoValueTF{#5}
      { \readex_path_source:nnn {#1} {line_number=#2\c_ampersand_str end_line_number=#3} {#4} }
      { \readex_identity_source:nnnn {#1} {#2} {line_number=#3\c_ampersand_str end_line_number=#4} {#5} }
  }
\NewDocumentCommand{\readeximagesource}{m m g}
  {
    \IfNoValueTF{#3}
      { \readex_path_source:nnn {#1} {} {#2} }
      { \readex_identity_source:nnnn {#1} {#2} {} {#3} }
  }
\NewDocumentCommand{\readexfilesource}{m m g}
  {
    \IfNoValueTF{#3}
      { \readex_path_source:nnn {#1} {} {#2} }
      { \readex_identity_source:nnnn {#1} {#2} {} {#3} }
  }
\ExplSyntaxOff

% The App regenerates readex-derived-links.tex from private source state before every
% build. Registered assets gain an invisible PDF link annotation; ordinary
% images keep the original graphicx behavior and appearance.
\ExplSyntaxOn
\prop_new:N \g_readex_derived_asset_link_prop
\cs_new_eq:NN \readex_original_includegraphics \includegraphics

\NewDocumentCommand{\readexregisterderivedasset}{mm}
  { \prop_gput:Nnn \g_readex_derived_asset_link_prop {#1} {#2} }

\cs_new_protected:Npn \readex_render_includegraphics:nnn #1#2#3
  {
    \IfBooleanTF{#1}
      {
        \IfNoValueTF{#2}
          { \readex_original_includegraphics*{#3} }
          { \readex_original_includegraphics*[#2]{#3} }
      }
      {
        \IfNoValueTF{#2}
          { \readex_original_includegraphics{#3} }
          { \readex_original_includegraphics[#2]{#3} }
      }
  }

% Derived figures are clickable provenance surfaces, but PDF's default link
% highlight mode inverts the entire annotation rectangle while pressed. Keep
% the hit target and hand cursor without tinting or otherwise altering the
% source image itself. The group keeps ordinary text-link feedback unchanged.
\cs_new_protected:Npn \readex_render_linked_graphic:nnnn #1#2#3#4
  {
    \group_begin:
      \hypersetup{pdfhighlight=/N}
      \href{#4}{\readex_render_includegraphics:nnn {#1}{#2}{#3}}
    \group_end:
  }

\RenewDocumentCommand{\includegraphics}{s o m}
  {
    \prop_get:NnNTF \g_readex_derived_asset_link_prop {#3} \l_tmpa_tl
      {
        \ifreadexlinks
          \readex_render_linked_graphic:nnnn {#1}{#2}{#3}{\l_tmpa_tl}
        \else
          \readex_render_includegraphics:nnn {#1}{#2}{#3}
        \fi
      }
      { \readex_render_includegraphics:nnn {#1}{#2}{#3} }
  }

\InputIfFileExists{readex-derived-links.tex}{}{}
\ExplSyntaxOff

\newcommand{\makereadexcover}{%
  \hypersetup{pageanchor=false}%
  \begin{titlepage}
  \begin{tikzpicture}[remember picture,overlay]
    \fill[ReadexInk] (current page.south west) rectangle (current page.north east);
    \fill[ReadexBlue] ([xshift=-4.8cm]current page.north east) rectangle (current page.north east);
    \fill[ReadexPink] ([yshift=2.2cm]current page.south west) rectangle ([yshift=3.0cm]current page.south east);
    \draw[ReadexYellow,line width=5pt] ([xshift=1.4cm,yshift=-1.5cm]current page.north west) -- ([xshift=7.6cm,yshift=-1.5cm]current page.north west);
  \end{tikzpicture}
  \vspace*{1.4cm}
  {\color{ReadexYellow}\bfseries\Large READOS STUDY MATERIAL\par}
  \vspace{1.2cm}
  {\color{white}\bfseries\fontsize{32}{40}\selectfont \readextitle\par}
  \vspace{0.55cm}
  {\color{white!78}\Large \readexsubtitle\par}
  \vfill
  \ifx\readexcoverimage\empty\else
    \begin{center}
      \includegraphics[width=0.82\textwidth,height=0.34\textheight,keepaspectratio]{\readexcoverimage}
    \end{center}
    \vfill
  \fi
  {\color{white!80}\large \readexauthor\par}
  \vspace{0.25cm}
  {\color{white!58}\readexdate\par}
  \vspace*{1.3cm}
  \end{titlepage}
  \hypersetup{pageanchor=true}%
}

\AtBeginDocument{%
  \renewcommand{\chaptermark}[1]{\markboth{#1}{}}
}
