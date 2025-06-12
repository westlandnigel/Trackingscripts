// ==UserScript==
// @name         Simkl Letterboxd Popular Reviews Importer
// @namespace    http://tampermonkey.net/
// @version      2.1
// @description  Imports Letterboxd reviews on Simkl. Auto-updates when navigating between movie pages without a full reload.
// @author       Nigel
// @match        https://simkl.com/movies/*
// @grant        GM_xmlhttpRequest
// @require      https://cdnjs.cloudflare.com/ajax/libs/jquery/3.5.1/jquery.min.js
// ==/UserScript==

(function() {
    'use strict';

    // A variable to hold a timer for debouncing, which prevents the script
    // from running too many times during page transitions.
    let debounceTimer;

    /**
     * This is the main function that finds, fetches, and injects the reviews.
     * It will be called on the initial page load and every time a page navigation is detected.
     */
    function runReviewImporter() {
        // First, clean up any reviews that might have been injected on a previous page.
        // This ensures we start with a clean slate for the new movie page.
        $('#letterboxd-reviews').remove();
        console.log("Cleaned up old reviews. Starting new review import...");

        fetchLetterboxdMovieUrl(fetchAndParseReviews);
    }

    /**
     * Step 1: Find the TMDB ID on the Simkl page and resolve it to the final Letterboxd movie URL.
     */
    function fetchLetterboxdMovieUrl(callback) {
        // Use a short delay to ensure the new page content is available.
        setTimeout(() => {
            try {
                let tmdbUrlElement = document.querySelector('a[href*="themoviedb.org/movie/"]');
                if (!tmdbUrlElement || !tmdbUrlElement.href) {
                    console.log("TMDB URL element not found on Simkl page. The script will wait for the next navigation.");
                    return;
                }

                let tmdbIdMatch = tmdbUrlElement.href.match(/\/movie\/(\d+)/);
                if (!tmdbIdMatch || !tmdbIdMatch[1]) {
                    console.log("TMDB ID could not be extracted from URL.");
                    return;
                }
                let tmdbId = tmdbIdMatch[1];
                console.log("Extracted TMDB ID: " + tmdbId);

                let letterboxdRedirectUrl = `https://letterboxd.com/tmdb/${tmdbId}`;
                console.log("Fetching Letterboxd page via redirect URL: " + letterboxdRedirectUrl);

                GM_xmlhttpRequest({
                    method: "GET",
                    url: letterboxdRedirectUrl,
                    onload: function(response) {
                        if (response.status === 200) {
                            let finalUrl = response.finalUrl;
                            console.log("Redirected to actual Letterboxd movie page: " + finalUrl);
                            callback(finalUrl);
                        } else {
                            console.log("Failed to get Letterboxd URL, status code: " + response.status);
                        }
                    },
                    onerror: function(error) {
                        console.error("Error while fetching Letterboxd redirect URL.", error);
                    }
                });
            } catch (error) {
                console.error("An error occurred in fetchLetterboxdMovieUrl: ", error);
            }
        }, 250); // A small 250ms delay can help with timing on SPAs.
    }

    /**
     * Step 2: Fetch the Letterboxd movie page and parse the reviews using the updated logic.
     */
    function fetchAndParseReviews(movieUrl) {
        GM_xmlhttpRequest({
            method: "GET",
            url: movieUrl,
            onload: function(response) {
                if (response.status !== 200) {
                    console.log("Failed to fetch Letterboxd reviews, status code: " + response.status);
                    return;
                }

                console.log("Successfully fetched Letterboxd page, parsing reviews...");
                const parser = new DOMParser();
                const doc = parser.parseFromString(response.responseText, 'text/html');

                const reviewArticles = doc.querySelectorAll('section.js-popular-reviews div.listitem article.production-viewing');

                if (reviewArticles.length === 0) {
                    console.log("No popular review articles found on Letterboxd page.");
                    // Still inject an empty container so the user knows the script tried.
                    injectReviewsIntoSimkl([]);
                    return;
                }

                const reviewsList = Array.from(reviewArticles).map((article) => {
                    const username = article.querySelector('strong.displayname')?.textContent.trim();
                    const profileImageUrl = article.querySelector('a.avatar img')?.src;
                    const rating = article.querySelector('span.rating')?.textContent.trim() || 'N/A';
                    const reviewUrl = `https://letterboxd.com${article.querySelector('a.context')?.getAttribute('href') || ''}`;

                    const contentContainer = article.querySelector('.js-review .body-text');
                    let content = "";
                    if (contentContainer) {
                        content = Array.from(contentContainer.querySelectorAll('p'))
                            .map(p => p.textContent.trim())
                            .join('<br><br>');
                    }

                    if (content && username && profileImageUrl && reviewUrl) {
                        return { content, username, profileImageUrl, rating, reviewUrl };
                    }
                    return null;
                }).filter(Boolean);

                console.log(`Found and parsed ${reviewsList.length} reviews.`);
                injectReviewsIntoSimkl(reviewsList);
            },
            onerror: function(error) {
                console.error("Error while fetching Letterboxd reviews page.", error);
            }
        });
    }

    /**
     * Step 3: Inject the parsed reviews into the Simkl page, using the original styling.
     */
    function injectReviewsIntoSimkl(reviews) {
        let targetElement = document.querySelector('#tvShowCommentsBlock');

        if (!targetElement) {
            console.log("Injection target element not found.");
            return;
        }

        // Create the main review container.
        let reviewSection = $('<div id="letterboxd-reviews"><h3 style="color:white;">Letterboxd Reviews</h3></div>');

        if (reviews.length > 0) {
            reviews.forEach((review) => {
                let reviewHtml = `
                    <div class="review" style="border: 1px solid #444; padding: 10px; margin: 10px 0; border-radius: 5px; background-color: #2e2e2e; color: white;">
                        <div style="display: flex; align-items: center; margin-bottom: 10px;">
                            <img src="${review.profileImageUrl}" alt="Profile picture" style="width: 40px; height: 40px; border-radius: 50%; margin-right: 10px;">
                            <p style="margin: 0;"><strong><a href="${review.reviewUrl}" target="_blank" style="color:white; text-decoration: none;">${review.username}</a></strong></p>
                        </div>
                        <div style="font-family: 'Roboto', sans-serif; line-height: 1.5;">${review.content}</div>
                        <p style="font-weight: bold; margin-top: 10px; margin-bottom: 0;">Rating: ${review.rating}</p>
                    </div>
                `;
                reviewSection.append(reviewHtml);
            });
        } else {
            // If no reviews were found, provide feedback to the user.
            reviewSection.append('<p style="color: #999; padding: 10px;">No Letterboxd reviews found for this movie.</p>');
        }

        $(targetElement).append(reviewSection);
    }

    // --- SPA NAVIGATION HANDLING ---

    // The target node to observe for changes. '#global_div' is a good candidate
    // as it contains the main content that gets replaced during navigation.
    const targetNode = document.getElementById('global_div');

    if (targetNode) {
        const config = { childList: true, subtree: true };

        const callback = function(mutationsList, observer) {
            // Use a debounce to prevent the function from firing multiple times
            // during a single page transition.
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                // Check if the URL has actually changed to avoid re-running on minor DOM updates.
                if (window.location.href !== (observer.lastUrl || '')) {
                    observer.lastUrl = window.location.href;
                    console.log('SPA navigation detected. Re-running the review importer.');
                    runReviewImporter();
                }
            }, 500); // 500ms delay is usually a safe bet for content to settle.
        };

        const observer = new MutationObserver(callback);
        observer.observe(targetNode, config);
        observer.lastUrl = window.location.href;
    } else {
        console.error("Simkl Watcher: Could not find target node '#global_div' to observe for SPA navigations.");
    }

    // Initial run of the script for the first page load.
    runReviewImporter();

})();