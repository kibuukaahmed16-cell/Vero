async function isForked(username) {
	const apiUrl = `https://api.github.com/repos/AstroX11/Xstro/forks`;
	const response = await fetch(apiUrl);
	if (!response.ok) return false;

	const forks = await response.json();
	const filteredForks = forks.filter(fork => fork.owner.login !== 'AstroX11');
	return filteredForks.some(fork => fork.owner.login === username);
}