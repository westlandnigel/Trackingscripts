import requests
from bs4 import BeautifulSoup
import csv
import re
import json
# Added 'as_completed' to the import to fix the NameError
from concurrent.futures import ThreadPoolExecutor, as_completed
from tqdm import tqdm

# --- Configuration ---
CSV_FILE = "letterboxd_list.csv"
CSV_HEADER = ["Letterboxd URL", "TMDB ID", "Type", "Title"]
MAX_WORKERS = 20

# Add a User-Agent to mimic a browser and avoid being blocked
HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
}

# --- Functions ---

def extract_movie_info_from_list_page(soup):
    """Extracts movie URLs and titles from a single list page."""
    movie_data = []
    
    # This selector works for both numbered and unnumbered lists
    movie_items = soup.select('li.poster-container')

    for li in movie_items:
        poster_div = li.find('div', class_='film-poster')
        
        if poster_div and poster_div.get('data-target-link'):
            movie_url = "https://letterboxd.com" + poster_div['data-target-link']
            img_tag = poster_div.find('img')
            title = img_tag.get('alt', 'No Title Found') if img_tag else 'No Title Found'
            movie_data.append({"url": movie_url, "title": title})
            
    return movie_data

def get_last_page(soup):
    """Finds the last page number from the pagination element on a page."""
    pagination = soup.find('div', class_='paginate-pages')
    if not pagination:
        return 1
        
    last_page_link = pagination.find_all('a')[-1]
    if last_page_link and last_page_link.get('href'):
        try:
            return int(last_page_link.get('href').split('/page/')[-1].strip('/'))
        except (ValueError, IndexError):
            return 1
    return 1

def get_tmdb_info(session, movie_info):
    """
    Fetches a movie page and uses your robust, multi-method approach
    to extract its TMDB ID and type.
    """
    movie_url = movie_info["url"]
    try:
        response = session.get(movie_url)
        response.raise_for_status()
        soup = BeautifulSoup(response.text, 'html.parser')

        tmdb_id = None
        media_type = "movie"

        # Method 1: Body data-tmdb-id (Often the most reliable)
        body_tag = soup.find('body')
        if body_tag and body_tag.get('data-tmdb-id'):
            tmdb_id = body_tag.get('data-tmdb-id')
            tmdb_type = body_tag.get('data-tmdb-type', 'movie').lower()
            media_type = "show" if tmdb_type == 'tv' else "movie"
        
        # Method 2: Fallback to data-track-action attribute on the button
        if not tmdb_id:
            tmdb_button = soup.find('a', {'data-track-action': 'TMDB'})
            if tmdb_button:
                tmdb_link = tmdb_button.get('href', '')
                id_match = re.search(r'/(movie|tv)/(\d+)', tmdb_link)
                if id_match:
                    tmdb_id = id_match.group(2)
                    media_type = "show" if id_match.group(1) == "tv" else "movie"
                    
        # Method 3: Fallback to ld+json script tag (Your excellent addition)
        if not tmdb_id:
            script_tag = soup.find('script', type='application/ld+json')
            if script_tag and script_tag.string:
                try:
                    json_data = json.loads(script_tag.string)
                    potential_urls = json_data.get('sameAs', [])
                    if isinstance(potential_urls, str):
                        potential_urls = [potential_urls]
                    
                    for item_url in potential_urls:
                        if "themoviedb.org" in item_url:
                            id_match = re.search(r'/(movie|tv)/(\d+)', item_url)
                            if id_match:
                                tmdb_id = id_match.group(2)
                                media_type = "show" if id_match.group(1) == "tv" else "movie"
                                break 
                except json.JSONDecodeError:
                    pass # Ignore if JSON is malformed

        if not tmdb_id:
            print(f"TMDB ID not found for {movie_url}")
            
        return movie_url, tmdb_id, media_type, movie_info["title"]

    except requests.RequestException as e:
        print(f"Error fetching {movie_url}: {e}")
        return movie_url, None, "movie", movie_info["title"]

def main():
    """Main function to orchestrate the scraping process."""
    base_url = input("Enter the Letterboxd list URL: ").strip().rstrip('/')
    
    print("Starting scraper...")
    
    all_movie_infos = []
    
    with requests.Session() as session:
        session.headers.update(HEADERS)
        
        print("Fetching first page to determine total number of pages...")
        try:
            first_page_response = session.get(base_url)
            first_page_response.raise_for_status()
            first_page_soup = BeautifulSoup(first_page_response.text, 'html.parser')
            
            all_movie_infos.extend(extract_movie_info_from_list_page(first_page_soup))
            last_page = get_last_page(first_page_soup)
            print(f"Found {last_page} page(s) in the list.")
            
        except requests.RequestException as e:
            print(f"Failed to fetch the list URL: {e}")
            return

        if last_page > 1:
            page_urls = [f"{base_url}/page/{i}/" for i in range(2, last_page + 1)]
            
            with ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
                future_to_url = {executor.submit(session.get, url): url for url in page_urls}
                for future in tqdm(as_completed(future_to_url), total=len(page_urls), desc="Scraping list pages"):
                    try:
                        response = future.result()
                        soup = BeautifulSoup(response.text, 'html.parser')
                        all_movie_infos.extend(extract_movie_info_from_list_page(soup))
                    except Exception as e:
                        print(f"Error processing page {future_to_url[future]}: {e}")

        print(f"Collected {len(all_movie_infos)} movies/shows from the list.")

        final_data = []
        with ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
            futures = [executor.submit(get_tmdb_info, session, movie_info) for movie_info in all_movie_infos]
            for future in tqdm(as_completed(futures), total=len(all_movie_infos), desc="Fetching TMDB IDs"):
                try:
                    result = future.result()
                    if result:
                        final_data.append(result)
                except Exception as e:
                    print(f"An error occurred while fetching TMDB info: {e}")

    # Sort data to match original list order before saving
    url_to_index = {info['url']: i for i, info in enumerate(all_movie_infos)}
    final_data.sort(key=lambda x: url_to_index.get(x[0], float('inf')))
    
    with open(CSV_FILE, mode='w', newline='', encoding='utf-8') as file:
        writer = csv.writer(file)
        writer.writerow(CSV_HEADER)
        writer.writerows(final_data)
        
    print(f"\nScraping complete! Data saved to {CSV_FILE}")

if __name__ == "__main__":
    main()